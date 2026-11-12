
import Database from "better-sqlite3";
import type { Dispute, Evidence, Analysis } from "./type.js";
import {
  extractBuyerEvidence,
  matchRequestedEvidence
} from "./evidenceMatching.js";

const db = new Database("dispute-defender.db");

// Improve database reliability
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables automatically
db.exec(`
  CREATE TABLE IF NOT EXISTS disputes (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    analysis TEXT,
    submitted_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispute_id TEXT NOT NULL,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    carrier TEXT,
    tracking_number TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dispute_id) REFERENCES disputes(id)
  );

  CREATE TABLE IF NOT EXISTS evidence_images (
    evidence_id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS submission_attempts (
    dispute_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('seller', 'automation')),
    status TEXT NOT NULL CHECK (status IN ('processing', 'submitted', 'needs_review')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    message TEXT,
    FOREIGN KEY (dispute_id) REFERENCES disputes(id)
  );
`);

db.prepare(`
  UPDATE submission_attempts
  SET status = 'needs_review',
      finished_at = ?,
      message = 'The server restarted during submission. Verify PayPal before taking further action.'
  WHERE status = 'processing'
`).run(new Date().toISOString());

export function saveDispute(dispute: Dispute) {
  const existing = db.prepare(
    "SELECT data FROM disputes WHERE id = ?"
  ).get(dispute.id) as { data: string } | undefined;
  const rawDataChanged = existing
    ? JSON.stringify(
        (JSON.parse(existing.data) as Dispute).rawData
      ) !== JSON.stringify(dispute.rawData)
    : false;

  const statement = db.prepare(`
    INSERT INTO disputes (id, data, analysis)
    VALUES (?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      analysis = CASE WHEN ? THEN NULL ELSE disputes.analysis END
  `);

  statement.run(dispute.id, JSON.stringify(dispute), rawDataChanged ? 1 : 0);
}

export function getDispute(id: string): Dispute | undefined {
  const row = db.prepare(
    "SELECT * FROM disputes WHERE id = ?"
  ).get(id) as any;

  if (!row) return undefined;

  const dispute = JSON.parse(row.data) as Dispute;

  const evidence = db.prepare(
    `SELECT evidence.*, evidence_images.filename AS image_filename,
      evidence_images.mime_type AS image_mime_type
     FROM evidence
     LEFT JOIN evidence_images ON evidence_images.evidence_id = evidence.id
     WHERE evidence.dispute_id = ?
     ORDER BY evidence.id`
  ).all(id) as any[];

  const enriched = {
    ...dispute,
    evidence: evidence.map(e => ({
      id: e.id,
      disputeId: e.dispute_id,
      type: e.type,
      text: e.text,
      carrier: e.carrier ?? undefined,
      trackingNumber: e.tracking_number ?? undefined,
      imageFilename: e.image_filename ?? undefined,
      imageMimeType: e.image_mime_type ?? undefined,
      createdAt: e.created_at
    })),
    analysis: row.analysis
      ? JSON.parse(row.analysis)
      : undefined,
    submittedAt: row.submitted_at ?? undefined,
    submissionAttempt: (() => {
      const automation = db.prepare(`
        SELECT mode, status, started_at, finished_at, message
        FROM submission_attempts WHERE dispute_id = ?
      `).get(id) as {
        mode: "seller" | "automation";
        status: "processing" | "submitted" | "needs_review";
        started_at: string;
        finished_at: string | null;
        message: string | null;
      } | undefined;

      return automation
        ? {
            mode: automation.mode,
            status: automation.status,
            startedAt: automation.started_at,
            finishedAt: automation.finished_at ?? undefined,
            message: automation.message ?? undefined
          }
        : undefined;
    })()
  };

  return {
    ...enriched,
    buyerEvidence: extractBuyerEvidence(enriched.rawData),
    requestedEvidence: matchRequestedEvidence(enriched)
  };
}

export function getAllDisputes(): Dispute[] {
  const rows = db.prepare(
    "SELECT id FROM disputes ORDER BY created_at DESC"
  ).all() as { id: string }[];

  return rows
    .map(row => getDispute(row.id))
    .filter((item): item is Dispute => item !== undefined);
}

export function addEvidence(
  disputeId: string,
  type: Evidence["type"],
  text: string,
  carrier?: string,
  trackingNumber?: string,
  image?: {
    filename: string;
    mimeType: string;
    data: Buffer;
  }
) {
  const addEvidenceTransaction = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO evidence
      (dispute_id, type, text, carrier, tracking_number)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      disputeId,
      type,
      text,
      carrier ?? null,
      trackingNumber ?? null
    );

    if (image) {
      db.prepare(`
        INSERT INTO evidence_images (evidence_id, filename, mime_type, data)
        VALUES (?, ?, ?, ?)
      `).run(result.lastInsertRowid, image.filename, image.mimeType, image.data);
    }

    db.prepare(
      "UPDATE disputes SET analysis = NULL WHERE id = ?"
    ).run(disputeId);

    return result.lastInsertRowid;
  });

  return addEvidenceTransaction();
}

export function getEvidenceImage(evidenceId: number) {
  return db.prepare(`
    SELECT evidence_images.filename, evidence_images.mime_type, evidence_images.data
    FROM evidence_images
    JOIN evidence ON evidence.id = evidence_images.evidence_id
    WHERE evidence.id = ?
  `).get(evidenceId) as
    | { filename: string; mime_type: string; data: Buffer }
    | undefined;
}

export function saveAnalysis(id: string, analysis: Analysis) {
  const result = db.prepare(`
    UPDATE disputes
    SET analysis = ?
    WHERE id = ?
  `).run(JSON.stringify(analysis), id);

  if (result.changes !== 1) {
    throw new Error("Analysis could not be persisted for the dispute.");
  }
}

export function claimSubmission(
  id: string,
  mode: "seller"
): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO submission_attempts
      (dispute_id, mode, status, started_at)
    VALUES (?, ?, 'processing', ?)
  `).run(id, mode, new Date().toISOString());
  return result.changes === 1;
}

export function finishSubmission(
  id: string,
  status: "submitted" | "needs_review",
  message: string
) {
  const finish = db.transaction(() => {
    const finishedAt = new Date().toISOString();
    db.prepare(`
      UPDATE submission_attempts
      SET status = ?, finished_at = ?, message = ?
      WHERE dispute_id = ? AND status = 'processing'
    `).run(status, finishedAt, message, id);

    if (status === "submitted") {
      db.prepare(`
        UPDATE disputes SET submitted_at = ? WHERE id = ?
      `).run(finishedAt, id);
    }
  });
  finish();
}

export function clearSubmissionAttemptAfterReview(id: string): boolean {
  const result = db.prepare(`
    DELETE FROM submission_attempts
    WHERE dispute_id = ? AND status = 'needs_review'
  `).run(id);
  return result.changes === 1;
}
