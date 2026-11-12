
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";

import {
  saveDispute,
  getDispute,
  getAllDisputes,
  addEvidence,
  getEvidenceImage,
  saveAnalysis,
  claimSubmission,
  finishSubmission,
  clearSubmissionAttemptAfterReview
} from "./db.js";

import {
  getDisputes as fetchPayPalDisputes,
  downloadPayPalDocument,
  getDisputeDetails,
  submitEvidence
} from "./paypal.js";

import { analyzeDispute, checkAIAvailability } from "./ai.js";
import {
  getBuyerEvidenceDocumentUrl,
  mapPayPalEvidenceType,
  normalizePayPalEvidenceType
} from "./evidenceMatching.js";

const app = express();
const PORT = Number(process.env.PORT || 3001);
const MAX_EVIDENCE_IMAGE_SIZE = 5 * 1024 * 1024;
const parseEvidenceImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_IMAGE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
      callback(new Error("Upload a JPEG or PNG image."));
      return;
    }

    callback(null, true);
  }
});

function getSafeEvidenceFilename(originalName: string, mimeType: string) {
  const extension = mimeType === "image/png" ? "png" : "jpg";
  const baseName = path.parse(originalName.replace(/\\/g, "/")).name
    .replace(/[^A-Za-z0-9-_,\s]/g, "_")
    .trim()
    .slice(0, 120);

  return `${baseName || "evidence"}.${extension}`;
}

function hasValidImageSignature(buffer: Buffer, mimeType: string) {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }

  return mimeType === "image/jpeg" &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
}

function hasSupportedBuyerImageSignature(buffer: Buffer, mimeType: string) {
  if (mimeType === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }
  if (mimeType === "image/gif") {
    return buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function parseEvidenceImageUpload(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  parseEvidenceImage.single("evidenceImage")(req, res, error => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? "Evidence image must be 5 MB or smaller."
          : "Only one evidence image can be uploaded."
      });
    }

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    next();
  });
}

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173"
}));

app.use(express.json({ limit: "1mb" }));

// Protect demo API using a shared app password.
function authenticate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const password = process.env.APP_PASSWORD;

  if (!password || req.header("x-app-password") !== password) {
    return res.status(401).json({
      error: "Unauthorized access."
    });
  }

  next();
}

async function synchronizeDisputes() {
  const result = await fetchPayPalDisputes();
  const items = result.items ?? [];

  for (const item of items) {
    const details = await getDisputeDetails(item.dispute_id);
    const id = String(details.dispute_id || item.dispute_id);
    const previous = getDispute(id);
    const disputeOutcome = details.dispute_outcome &&
      typeof details.dispute_outcome === "object"
      ? (details.dispute_outcome as Record<string, unknown>).outcome_code
      : details.outcome_code;

    saveDispute({
      id,
      reason: String(details.reason || "UNKNOWN"),
      status: String(details.status || "UNKNOWN"),
      amount: String(
        (details.dispute_amount as any)?.value || "0"
      ),
      currency: String(
        (details.dispute_amount as any)?.currency_code || ""
      ),
      createdAt: String(
        details.create_time || details.createTime || previous?.createdAt || ""
      ) || undefined,
      updatedAt: String(
        details.update_time ||
        details.updateTime ||
        details.create_time ||
        previous?.updatedAt ||
        ""
      ) || undefined,
      outcome: typeof disputeOutcome === "string"
        ? disputeOutcome
        : previous?.outcome,
      dueDate: details.seller_response_due_date
        ? String(details.seller_response_due_date)
        : undefined,
      lifecycleStage: details.dispute_life_cycle_stage
        ? String(details.dispute_life_cycle_stage)
        : undefined,
      rawData: details,
      evidence: previous?.evidence ?? [],
      analysis: previous?.analysis,
      submittedAt: previous?.submittedAt
    });
  }

  return {
    count: items.length,
    disputes: getAllDisputes()
  };
}

function buildEvidenceSubmission(
  dispute: NonNullable<ReturnType<typeof getDispute>>,
  evidenceType: string,
  draft: string
) {
  const requestedEvidence = (
    dispute.rawData as any
  ).evidences?.find((item: any) =>
    item.source === "REQUESTED_FROM_SELLER" &&
    normalizePayPalEvidenceType(item.evidence_type) ===
      normalizePayPalEvidenceType(evidenceType)
  );
  if (!requestedEvidence) {
    throw new Error("Evidence type was not requested by PayPal.");
  }

  const internalEvidenceType = mapPayPalEvidenceType(evidenceType);
  const supportingEvidence = dispute.evidence.filter(item =>
    item.type === internalEvidenceType && item.text.trim().length > 0
  );

  if (internalEvidenceType === "tracking") {
    const tracking = supportingEvidence.filter(
      item => item.type === "tracking" &&
        item.carrier &&
        item.trackingNumber &&
        item.text.trim().length > 0
    );
    if (!tracking.length) throw new Error("Add tracking evidence first.");
  } else if (
    internalEvidenceType === "note" ||
    internalEvidenceType === "invoice" ||
    internalEvidenceType === "message"
  ) {
    if (!supportingEvidence.length) {
      throw new Error(`Add ${internalEvidenceType} evidence first.`);
    }
  } else {
    throw new Error("This evidence type is not supported yet.");
  }

  const evidenceWithImage = [...supportingEvidence]
    .reverse()
    .find(item => item.imageFilename);
  const evidenceImage = evidenceWithImage
    ? getEvidenceImage(evidenceWithImage.id)
    : undefined;

  const evidence: Record<string, unknown> = {
    evidence_type: evidenceType,
    ...(internalEvidenceType === "tracking"
      ? {
          evidence_info: {
            tracking_info: supportingEvidence
              .filter(item => item.type === "tracking" && item.carrier && item.trackingNumber)
              .map(item => ({
                carrier_name: item.carrier,
                tracking_number: item.trackingNumber
              }))
          }
        }
      : {}),
    notes: draft.trim(),
    ...(evidenceImage
      ? { documents: [{ name: evidenceImage.filename }] }
      : {})
  };

  return { evidence, evidenceImage };
}

app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

app.use("/api", authenticate);

app.get("/api/ai/status", async (_req, res) => {
  res.json(await checkAIAvailability());
});

// 1. Fetch and synchronize PayPal disputes
app.post("/api/sync", async (_req, res) => {
  try {
    const result = await synchronizeDisputes();
    res.json({
      message: "PayPal disputes synchronized.",
      ...result
    });

  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({
      error: "Unable to synchronize PayPal disputes."
    });
  }
});

// 2. List disputes
app.get("/api/disputes", (_req, res) => {
  res.json(getAllDisputes());
});

// 3. Get one dispute
app.get("/api/disputes/:id", (req, res) => {
  const dispute = getDispute(req.params.id);

  if (!dispute) {
    return res.status(404).json({
      error: "Dispute not found."
    });
  }

  res.json(dispute);
});

// 4. Add seller evidence
app.post("/api/disputes/:id/evidence", parseEvidenceImageUpload, (req, res) => {
  const disputeId = String(req.params.id);
  const dispute = getDispute(disputeId);

  if (!dispute) {
    return res.status(404).json({
      error: "Dispute not found."
    });
  }

  const { type, text, carrier, trackingNumber } = req.body;

  const allowedTypes = [
    "tracking",
    "note",
    "invoice",
    "message"
  ];

  if (!allowedTypes.includes(type)) {
    return res.status(400).json({
      error: "Invalid evidence type."
    });
  }

  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 3000
  ) {
    return res.status(400).json({
      error: "Evidence text is required."
    });
  }

  if (
    type === "tracking" &&
    (!carrier?.trim() || !trackingNumber?.trim())
  ) {
    return res.status(400).json({
      error: "Carrier and tracking number are required."
    });
  }

  const uploadedFile = req.file;
  if (uploadedFile && (
    uploadedFile.size === 0 ||
    !hasValidImageSignature(uploadedFile.buffer, uploadedFile.mimetype)
  )) {
    return res.status(400).json({
      error: "The uploaded file is empty or its content does not match its image type."
    });
  }

  const image = uploadedFile
    ? {
        filename: getSafeEvidenceFilename(
          uploadedFile.originalname,
          uploadedFile.mimetype
        ),
        mimeType: uploadedFile.mimetype,
        data: uploadedFile.buffer
      }
    : undefined;

  addEvidence(
    dispute.id,
    type,
    text.trim(),
    carrier,
    trackingNumber,
    image
  );

  res.status(201).json(getDispute(dispute.id));
});

app.get(
  "/api/disputes/:id/evidence/:evidenceId/image",
  (req, res) => {
    const dispute = getDispute(req.params.id);
    const evidenceId = Number(req.params.evidenceId);
    if (!dispute || !Number.isSafeInteger(evidenceId)) {
      return res.status(404).json({ error: "Evidence image not found." });
    }

    const evidence = dispute.evidence.find(item => item.id === evidenceId);
    const image = evidence ? getEvidenceImage(evidenceId) : undefined;
    if (!image) {
      return res.status(404).json({ error: "Evidence image not found." });
    }

    res.setHeader("Content-Type", image.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${image.filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(image.data);
  }
);

app.get(
  "/api/disputes/:id/buyer-evidence/:evidenceIndex/document/:documentIndex/image",
  async (req, res) => {
    const dispute = getDispute(String(req.params.id));
    const evidenceIndex = Number(req.params.evidenceIndex);
    const documentIndex = Number(req.params.documentIndex);
    if (
      !dispute ||
      !Number.isSafeInteger(evidenceIndex) ||
      evidenceIndex < 0 ||
      !Number.isSafeInteger(documentIndex) ||
      documentIndex < 0
    ) {
      return res.status(404).json({ error: "Buyer evidence image not found." });
    }

    const documentUrl = getBuyerEvidenceDocumentUrl(
      dispute.rawData,
      evidenceIndex,
      documentIndex
    );
    if (!documentUrl) {
      return res.status(404).json({
        error: "PayPal did not provide a downloadable URL for this attachment."
      });
    }

    try {
      const document = await downloadPayPalDocument(documentUrl);
      if (
        !hasSupportedBuyerImageSignature(document.data, document.contentType)
      ) {
        return res.status(415).json({
          error: "This buyer attachment is not an image that can be previewed."
        });
      }

      res.setHeader("Content-Type", document.contentType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      return res.send(document.data);
    } catch (error) {
      console.error("Buyer evidence download error:", error);
      return res.status(502).json({
        error: error instanceof Error
          ? error.message
          : "Could not retrieve the buyer attachment from PayPal."
      });
    }
  }
);

// 5. Analyze dispute evidence using the configured analysis provider
app.post("/api/disputes/:id/analyze", async (req, res) => {
  try {
    const dispute = getDispute(req.params.id);

    if (!dispute) {
      return res.status(404).json({
        error: "Dispute not found."
      });
    }

    if (dispute.evidence.length === 0) {
      return res.status(409).json({
        error: "Add seller evidence before analyzing the dispute."
      });
    }

    const analysis = await analyzeDispute(dispute);

    saveAnalysis(dispute.id, analysis);

    const updatedDispute = getDispute(dispute.id);

    if (!updatedDispute) {
      return res.status(500).json({
        error: "Analysis was saved, but the dispute could not be reloaded."
      });
    }

    res.json(updatedDispute);

  } catch (error) {
    console.error("AI analysis error:", error);

    if (error instanceof Error && error.message.includes("timed out")) {
      return res.status(504).json({ error: error.message });
    }

    if (
      error instanceof Error &&
      (error.message.includes("not reachable") ||
        error.message.includes("not installed") ||
        error.message.includes("could not find model"))
    ) {
      return res.status(503).json({ error: error.message });
    }

    res.status(500).json({
      error: error instanceof Error
        ? error.message
        : "AI analysis failed."
    });
  }
});

app.post("/api/disputes/:id/submission-attempt/reconcile", (req, res) => {
  const dispute = getDispute(req.params.id);
  if (!dispute) {
    return res.status(404).json({ error: "Dispute not found." });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: "Confirm that you checked PayPal and the submission was not accepted."
    });
  }
  if (!clearSubmissionAttemptAfterReview(dispute.id)) {
    return res.status(409).json({
      error: "There is no failed or uncertain submission attempt to clear."
    });
  }
  res.json({
    message: "Submission attempt cleared after seller verification.",
    dispute: getDispute(dispute.id)
  });
});

// 6. Submit evidence after seller confirmation
app.post("/api/disputes/:id/submit", async (req, res) => {
  let submissionClaimedFor: string | null = null;
  try {
    const dispute = getDispute(req.params.id);

    if (!dispute) {
      return res.status(404).json({
        error: "Dispute not found."
      });
    }

    if (dispute.submittedAt) {
      return res.status(409).json({
        error: "Submission already recorded."
      });
    }

    if (dispute.submissionAttempt) {
      return res.status(409).json({
        error: dispute.submissionAttempt.status === "needs_review"
          ? "A previous submission needs verification in PayPal before another submission."
          : "A submission is already in progress or recorded."
      });
    }

    if (dispute.status !== "WAITING_FOR_SELLER_RESPONSE") {
      return res.status(409).json({
        error: "Dispute is not awaiting seller response."
      });
    }

    if (!dispute.analysis) {
      return res.status(409).json({
        error: "Run the AI evidence analysis after the latest evidence update before submitting."
      });
    }

    const { draft, confirm, evidenceType } = req.body;

    if (
      (confirm !== "true" && confirm !== true) ||
      typeof draft !== "string" ||
      !draft.trim()
    ) {
      return res.status(400).json({
        error: "Seller confirmation is required."
      });
    }

    let submission: ReturnType<typeof buildEvidenceSubmission>;
    try {
      submission = buildEvidenceSubmission(dispute, evidenceType, draft);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid evidence."
      });
    }

    if (!claimSubmission(dispute.id, "seller")) {
      return res.status(409).json({
        error: "A submission attempt already exists. Verify the PayPal case before retrying."
      });
    }
    submissionClaimedFor = dispute.id;

    const result = await submitEvidence(
      dispute.id,
      [submission.evidence],
      submission.evidenceImage
        ? {
            buffer: submission.evidenceImage.data,
            mimetype: submission.evidenceImage.mime_type,
            filename: submission.evidenceImage.filename
          }
        : undefined
    );

    finishSubmission(
      dispute.id,
      "submitted",
      "Seller-approved evidence submission was confirmed by PayPal."
    );
    submissionClaimedFor = null;

    res.json({
      success: true,
      message: "Evidence submission request sent to PayPal.",
      result,
      dispute: getDispute(dispute.id)
    });

  } catch (error) {
    console.error("Submission error:", error);
    if (submissionClaimedFor) {
      finishSubmission(
        submissionClaimedFor,
        "needs_review",
        "Submission could not be confirmed. Verify the PayPal case before retrying."
      );
    }

    res.status(502).json({
      error: error instanceof Error &&
        error.message.startsWith("PayPal accepted the image upload")
        ? error.message
        : "PayPal evidence submission failed or could not be confirmed. Check PayPal before retrying."
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Dispute Defender backend running on http://localhost:${PORT}`
  );
});
