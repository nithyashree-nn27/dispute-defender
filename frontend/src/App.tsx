
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  LayoutDashboard,
  RefreshCw,
  Search,
  Package,
  CheckCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FileCheck2,
  Filter,
  Hourglass,
  Trophy,
  Send,
  CalendarDays,
  Circle,
  Sparkles,
  Bot,
  X,
  Copy,
  LogOut,
  AlertCircle,
  ArrowLeft,
  Plus,
  Upload,
  Image

} from "lucide-react";
import {
  apiRequest,
  syncDisputes,
  analyzeDispute,
  fetchEvidenceImage
} from "./api";
import { getWorkflowSteps as buildWorkflowSteps } from "./workflow";
import "./App.css";

interface Evidence {
  id: number;
  type: string;
  text: string;
  carrier?: string;
  trackingNumber?: string;
  imageFilename?: string;
  createdAt?: string;
}

interface BuyerEvidence {
  type: string;
  details: string[];
  documents: Array<{
    index: number;
    name: string;
    downloadable: boolean;
  }>;
}

interface Analysis {
  summary?: string;
  buyerClaims?: string[];
  sellerEvidenceAssessment?: string[];
  conflicts?: string[];
  recommendedActions?: string[];
  strength: number;
  missing: string[];
  draft: string;
  why: string;
}

interface AIStatus {
  available: boolean;
  provider: string;
  model: string;
  message: string;
}

interface RequestedEvidence {
  paypalEvidenceType: string;
  notes?: string;
  status: "available" | "missing" | "needs_verification";
  verificationRequired: boolean;
}

interface Dispute {
  id: string;
  reason: string;
  status: string;
  amount: string;
  currency: string;
  createdAt?: string;
  updatedAt?: string;
  outcome?: string;
  lifecycleStage?: string;
  dueDate?: string;
  evidence: Evidence[];
  buyerEvidence?: BuyerEvidence[];
  analysis?: Analysis;
  requestedEvidence?: RequestedEvidence[];
  submittedAt?: string;
  submissionAttempt?: {
    mode: "seller" | "automation";
    status: "processing" | "submitted" | "needs_review";
    startedAt: string;
    finishedAt?: string;
    message?: string;
  };
}

type Page = "dashboard" | "disputes" | "ai";
type DisputeStatusFilter =
  | "all"
  | "needs-response"
  | "waiting-for-buyer"
  | "under-review"
  | "response-submitted"
  | "resolved";

interface EvidenceImagePreviewProps {
  endpoint: string;
  password: string;
  alt: string;
}

function EvidenceImagePreview({
  endpoint,
  password,
  alt
}: EvidenceImagePreviewProps) {
  const [loadedImage, setLoadedImage] = useState<{
    endpoint: string;
    url: string;
  } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{
    endpoint: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";

    fetchEvidenceImage(endpoint, password, controller.signal)
      .then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setLoadedImage({ endpoint, url: objectUrl });
      })
      .catch(error => {
        if (!active || controller.signal.aborted) return;
        setLoadFailure({
          endpoint,
          message: error instanceof Error
            ? error.message
            : "Could not load this image."
        });
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint, password]);

  if (loadFailure?.endpoint === endpoint) {
    return <p className="image-preview-error">{loadFailure.message}</p>;
  }
  if (loadedImage?.endpoint !== endpoint) {
    return <p className="image-preview-loading">Loading image preview…</p>;
  }
  return (
    <img
      className="evidence-image-preview"
      src={loadedImage.url}
      alt={alt}
    />
  );
}

function App() {
  const [password, setPassword] = useState("");
  const [loginInput, setLoginInput] = useState("");
  const [authenticated, setAuthenticated] = useState(false);

  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [selectedDispute, setSelectedDispute] =
    useState<Dispute | null>(null);

  const [page, setPage] = useState<Page>("dashboard");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<DisputeStatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [syncError, setSyncError] = useState("");
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null);
  const [botPanelOpen, setBotPanelOpen] = useState(false);
  const [assistantStatus, setAssistantStatus] = useState<AIStatus | null>(null);
  const [assistantStatusError, setAssistantStatusError] = useState("");
  const aiStatusLoading = authenticated && page === "ai" && aiStatus === null;
  const selectedDisputeId = selectedDispute?.id;
  const syncInProgressRef = useRef(false);
  const syncSessionRef = useRef(0);
  const knownDisputeIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!authenticated || !botPanelOpen || !selectedDisputeId) return;

    let active = true;
    const refreshStatus = async () => {
      try {
        const status = await apiRequest(
          "/api/ai/status",
          password
        ) as AIStatus;
        if (active) {
          setAssistantStatus(status);
          setAssistantStatusError("");
        }
      } catch (err) {
        if (active) {
          setAssistantStatusError(
            err instanceof Error
              ? err.message
              : "Could not load AI status."
          );
        }
      }
    };

    void refreshStatus();
    return () => {
      active = false;
    };
  }, [authenticated, botPanelOpen, password, selectedDisputeId]);

  useEffect(() => {
    if (!authenticated || page !== "ai") return;

    let active = true;

    apiRequest("/api/ai/status", password)
      .then((status: AIStatus) => {
        if (active) setAIStatus(status);
      })
      .catch((err: unknown) => {
        if (active) {
          setAIStatus({
            available: false,
            provider: "Ollama",
            model: "qwen2.5:7b",
            message: err instanceof Error
              ? err.message
              : "Unable to check local AI status."
          });
        }
      });

    return () => {
      active = false;
    };
  }, [authenticated, page, password]);

  // Evidence form state
  const [evidenceType, setEvidenceType] = useState("tracking");
  const [evidenceText, setEvidenceText] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [evidenceImage, setEvidenceImage] = useState<File | null>(null);
  const evidenceImageInputRef = useRef<HTMLInputElement>(null);
  const [savingEvidence, setSavingEvidence] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [submittingEvidence, setSubmittingEvidence] = useState(false);
  const [submissionEvidenceType, setSubmissionEvidenceType] =
    useState("");
  const [submissionDraft, setSubmissionDraft] = useState("");
  const [submissionConfirmed, setSubmissionConfirmed] = useState(false);
  const [reconcileConfirmed, setReconcileConfirmed] = useState(false);
  const [reconcilingSubmission, setReconcilingSubmission] = useState(false);

  async function loadDisputes(secret: string) {
    const data = await apiRequest("/api/disputes", secret);
    knownDisputeIdsRef.current = new Set(
      data.map((item: Dispute) => item.id)
    );
    setDisputes(data);
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();

    setError("");
    setLoading(true);

    try {
      await apiRequest("/api/disputes", loginInput);

      setPassword(loginInput);
      await loadDisputes(loginInput);

      syncSessionRef.current += 1;
      setAuthenticated(true);
    } catch {
      setError("Login failed. Check your APP_PASSWORD.");
    } finally {
      setLoading(false);
    }
  }

  const syncFromPayPal = useCallback(async () => {
    if (syncInProgressRef.current) return;
    syncInProgressRef.current = true;
    const session = syncSessionRef.current;
    setSyncing(true);
    setSyncError("");
    setError("");
    setMessage("");

    try {
      const result = await syncDisputes(password);
      if (session !== syncSessionRef.current) return;

      const newDisputeCount = result.disputes.filter(
        (item: Dispute) => !knownDisputeIdsRef.current.has(item.id)
      ).length;
      knownDisputeIdsRef.current = new Set(
        result.disputes.map((item: Dispute) => item.id)
      );
      setDisputes(result.disputes);
      setSubmissionEvidenceType("");
      setSubmissionDraft("");
      setSubmissionConfirmed(false);

      setSelectedDispute(current =>
        current
          ? result.disputes.find(
              (item: Dispute) => item.id === current.id
            ) ?? null
          : null
      );

      setLastSyncedAt(new Date());
      setMessage(
        `Successfully synchronized ${result.count} PayPal disputes.${
          newDisputeCount
            ? ` ${newDisputeCount} new dispute${newDisputeCount === 1 ? "" : "s"} need review.`
            : ""
        }`
      );
    } catch (err) {
      if (session === syncSessionRef.current) {
        const syncFailure = err instanceof Error
          ? err.message
          : "PayPal synchronization failed.";
        setSyncError(syncFailure);
        setError(syncFailure);
      }
    } finally {
      syncInProgressRef.current = false;
      setSyncing(false);
    }
  }, [password]);

  function handleSync() {
    void syncFromPayPal();
  }

  function logout() {
    syncSessionRef.current += 1;
    setPassword("");
    setLoginInput("");
    setAuthenticated(false);
    setDisputes([]);
    setSelectedDispute(null);
    setPage("dashboard");
    setLastSyncedAt(null);
    setSyncError("");
  }

  function openDispute(dispute: Dispute) {
    setSelectedDispute(dispute);
    setAssistantStatus(null);
    setError("");
    setMessage("");
    setSubmissionEvidenceType("");
    setSubmissionDraft("");
    setSubmissionConfirmed(false);

    setEvidenceType("tracking");
    setEvidenceText("");
    setCarrier("");
    setTrackingNumber("");
    setEvidenceImage(null);
    if (evidenceImageInputRef.current) {
      evidenceImageInputRef.current.value = "";
    }
  }

  // Save evidence to the backend
  async function handleAddEvidence() {
    if (!selectedDispute || !evidenceText.trim()) {
      setError("Please enter evidence details.");
      return;
    }

    if (
      evidenceType === "tracking" &&
      (!carrier.trim() || !trackingNumber.trim())
    ) {
      setError("Please enter the carrier and tracking number.");
      return;
    }

    setSavingEvidence(true);
    setError("");
    setMessage("");

    try {
      const body = new FormData();
      body.set("type", evidenceType);
      body.set("text", evidenceText.trim());
      body.set("carrier", evidenceType === "tracking" ? carrier.trim() : "");
      body.set(
        "trackingNumber",
        evidenceType === "tracking" ? trackingNumber.trim() : ""
      );
      if (evidenceImage) body.set("evidenceImage", evidenceImage);

      const updated = await apiRequest(
        `/api/disputes/${encodeURIComponent(selectedDispute.id)}/evidence`,
        password,
        {
          method: "POST",
          body
        }
      );

      setSelectedDispute(updated);

      setDisputes(previous =>
        previous.map(item =>
          item.id === updated.id ? updated : item
        )
      );
      setAssistantStatus(null);
      setSubmissionEvidenceType("");
      setSubmissionDraft("");
      setSubmissionConfirmed(false);

      setEvidenceText("");
      setCarrier("");
      setTrackingNumber("");
      setEvidenceImage(null);
      if (evidenceImageInputRef.current) {
        evidenceImageInputRef.current.value = "";
      }

      setMessage(
        evidenceImage
          ? "Evidence and image saved successfully."
          : "Evidence saved successfully."
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not save evidence."
      );
    } finally {
      setSavingEvidence(false);
    }
  }

  
async function handleAnalyze() {
  if (!selectedDispute) return;

  setSubmissionEvidenceType("");
  setSubmissionDraft("");
  setSubmissionConfirmed(false);
  setAnalyzing(true);
  setError("");
  setMessage("");

  try {
    const updated = await analyzeDispute(
      selectedDispute.id,
      password
    );

    if (!updated?.id || !updated?.analysis) {
      throw new Error(
        "The server returned an analysis without dispute details."
      );
    }

    setSelectedDispute(updated);

    setDisputes(previous =>
      previous.map(item =>
        item.id === updated.id ? updated : item
      )
    );
    setAssistantStatus(null);

    setMessage("Evidence analysis completed successfully.");
  } catch (err) {
    setError(
      err instanceof Error
        ? err.message
        : "Evidence analysis failed."
    );
  } finally {
    setAnalyzing(false);
  }
}

  async function handleSubmitEvidence() {
    if (!selectedDispute || !submissionEvidenceType) return;

    setSubmittingEvidence(true);
    setError("");
    setMessage("");

    try {
      const response = await apiRequest(
        `/api/disputes/${encodeURIComponent(selectedDispute.id)}/submit`,
        password,
        {
          method: "POST",
          body: JSON.stringify({
            evidenceType: submissionEvidenceType,
            draft: submissionDraft.trim(),
            confirm: submissionConfirmed
          })
        }
      );

      const updated = response.dispute ?? selectedDispute;
      setSelectedDispute(updated);
      setDisputes(previous =>
        previous.map(item => item.id === updated.id ? updated : item)
      );
      setSubmissionEvidenceType("");
      setSubmissionDraft("");
      setSubmissionConfirmed(false);
      setMessage(response.message || "Evidence submitted successfully.");
      setAssistantStatus(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Evidence submission failed."
      );
    } finally {
      setSubmittingEvidence(false);
    }
  }

  async function handleReconcileSubmission() {
    if (!selectedDispute || !reconcileConfirmed) return;
    setReconcilingSubmission(true);
    setError("");
    setMessage("");
    try {
      const response = await apiRequest(
        `/api/disputes/${encodeURIComponent(selectedDispute.id)}/submission-attempt/reconcile`,
        password,
        {
          method: "POST",
          body: JSON.stringify({ confirm: true })
        }
      );
      const updated = response.dispute as Dispute;
      setSelectedDispute(updated);
      setDisputes(previous =>
        previous.map(item => item.id === updated.id ? updated : item)
      );
      setReconcileConfirmed(false);
      setMessage(response.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reconcile the submission.");
    } finally {
      setReconcilingSubmission(false);
    }
  }

  async function handleCopyBotDraft() {
    const draft = selectedDispute?.analysis?.draft;
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setMessage("AI draft copied to clipboard.");
    } catch {
      setError("Could not copy the AI draft.");
    }
  }


  function getDisputeStatus(status: string, submittedAt?: boolean) {
    const normalized = status.trim().toUpperCase();
    if (normalized.includes("RESOLVED") || normalized.includes("CLOSED")) {
      if (normalized.includes("WON")) {
        return { label: "Resolved – Won", className: "resolved-won", icon: Check };
      }
      if (normalized.includes("LOST")) {
        return { label: "Resolved – Lost", className: "resolved-lost", icon: AlertCircle };
      }
      return { label: "Resolved", className: "resolved", icon: Check };
    }
    if (submittedAt) {
      return { label: "Response Submitted", className: "submitted", icon: FileCheck2 };
    }
    if (normalized === "WAITING_FOR_SELLER_RESPONSE") {
      return { label: "Needs Response", className: "needs-response", icon: Hourglass };
    }
    if (normalized === "WAITING_FOR_BUYER_RESPONSE") {
      return { label: "Waiting for Buyer", className: "waiting-buyer", icon: Hourglass };
    }
    if (normalized.includes("UNDER_REVIEW") || normalized.includes("UNDER REVIEW")) {
      return { label: "Under Review", className: "under-review", icon: Hourglass };
    }
    return {
      label: normalized.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, char => char.toUpperCase()) || "Unknown",
      className: "under-review",
      icon: Hourglass
    };
  }

  function getFilteredDisputes() {
    return disputes.filter(item => {
      const currentStatus = getDisputeStatus(item.status, Boolean(item.submittedAt));
      const statusMatches = statusFilter === "all" ||
        (statusFilter === "needs-response" && currentStatus.className === "needs-response") ||
        (statusFilter === "waiting-for-buyer" && currentStatus.className === "waiting-buyer") ||
        (statusFilter === "under-review" && currentStatus.className === "under-review") ||
        (statusFilter === "response-submitted" && currentStatus.className === "submitted") ||
        (statusFilter === "resolved" && currentStatus.className.startsWith("resolved"));
      const searchMatches = `${item.id} ${item.reason} ${item.status}`
        .toLowerCase()
        .includes(search.toLowerCase());
      return statusMatches && searchMatches;
    });
  }

  const filtered = getFilteredDisputes();

  function formatUpdatedDate(updatedAt?: string) {
    if (!updatedAt) return "—";
    const date = new Date(updatedAt);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function getOutcome(dispute: Dispute): "seller-won" | "buyer-won" | "unknown" {
    const outcome = (dispute.outcome ?? "").toUpperCase();
    if (
      outcome.includes("SELLER_FAVOUR") ||
      outcome.includes("SELLER_FAVOR") ||
      outcome.includes("MERCHANT_FAVOUR") ||
      outcome.includes("MERCHANT_FAVOR") ||
      outcome.includes("SELLER_WON")
    ) {
      return "seller-won";
    }
    if (
      outcome.includes("BUYER_FAVOUR") ||
      outcome.includes("BUYER_FAVOR") ||
      outcome.includes("BUYER_WON")
    ) {
      return "buyer-won";
    }
    return "unknown";
  }

  function isCaseClosed(dispute: Dispute) {
    return /RESOLVED|CLOSED/.test(dispute.status.toUpperCase());
  }

  function getTimelineSteps(dispute: Dispute) {
    const closed = isCaseClosed(dispute);
    const waitingForBuyer =
      dispute.status.toUpperCase() === "WAITING_FOR_BUYER_RESPONSE";
    const responseSubmitted = Boolean(dispute.submittedAt) || waitingForBuyer;
    const evidenceAdded =
      dispute.evidence.length > 0 ||
      Boolean(dispute.buyerEvidence?.length) ||
      responseSubmitted;
    const underReview =
      closed ||
      (responseSubmitted &&
        !waitingForBuyer &&
        /REVIEW|SELLER_RESPONSE|WAITING_FOR_SELLER/.test(
          dispute.status.toUpperCase()
        ));
    const firstSellerEvidence = dispute.evidence
      .map(item => item.createdAt)
      .filter((date): date is string => Boolean(date))
      .sort()[0];

    return [
      {
        label: "Dispute opened",
        date: formatUpdatedDate(dispute.createdAt),
        complete: true,
        current: false
      },
      {
        label: "Evidence added",
        date: formatUpdatedDate(firstSellerEvidence),
        complete: evidenceAdded,
        current: false
      },
      {
        label: "Response submitted",
        date: formatUpdatedDate(dispute.submittedAt),
        complete: responseSubmitted,
        current: responseSubmitted && !underReview && !closed
      },
      {
        label: "Under review",
        date: underReview ? formatUpdatedDate(dispute.updatedAt) : "—",
        complete: underReview,
        current: underReview && !closed
      },
      {
        label: "Resolved",
        date: closed ? formatUpdatedDate(dispute.updatedAt) : "—",
        complete: closed,
        current: false
      }
    ];
  }

  function getWorkflowSteps(dispute: Dispute) {
    const steps = buildWorkflowSteps({
      synced: Boolean(lastSyncedAt),
      evidenceCount: dispute.evidence.length,
      analyzed: Boolean(dispute.analysis),
      responseGenerated: Boolean(dispute.analysis?.draft.trim()),
      sellerApproved: submissionConfirmed,
      submitted: Boolean(dispute.submittedAt)
    });
    const submissionDetail = dispute.submittedAt
      ? `Submitted to PayPal · ${formatUpdatedDate(dispute.submittedAt)}.`
      : dispute.submissionAttempt?.status === "needs_review"
        ? "Submission outcome is uncertain; check PayPal before retrying."
        : dispute.submissionAttempt?.status === "processing"
          ? "Submission is being sent to PayPal."
          : "Submit only after you have reviewed and approved the response.";

    return steps.map((step, index) => ({
      ...step,
      detail: [
        "The buyer raises the case through PayPal.",
        lastSyncedAt
          ? `Synced with PayPal at ${formatUpdatedDate(lastSyncedAt.toISOString())}.`
          : "Select Sync PayPal to refresh this dispute.",
        dispute.evidence.length
          ? `${dispute.evidence.length} seller record${dispute.evidence.length === 1 ? "" : "s"} saved.`
          : "Add seller records before requesting analysis.",
        dispute.analysis
          ? "The dispute and seller evidence have been analyzed."
          : "Analyze the dispute after adding seller evidence.",
        dispute.analysis?.draft
          ? "A response draft is ready for seller review."
          : "The AI response is generated with the evidence analysis.",
        submissionConfirmed
          ? "You confirmed the response and evidence for submission."
          : "Review the AI draft and confirm the evidence is accurate.",
        submissionDetail
      ][index]
    }));
  }

  const workflowSteps = selectedDispute
    ? getWorkflowSteps(selectedDispute)
    : [];
  const activeWorkflowStep = workflowSteps.findIndex(step => !step.complete);

  if (!authenticated) {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={login}>
          <div className="brand-icon">
            <ShieldCheck size={30} />
          </div>

          <h1>Dispute Defender</h1>

          <p>Sign in to your seller workspace.</p>

          <label>Application password</label>

          <input
            type="password"
            value={loginInput}
            onChange={e => setLoginInput(e.target.value)}
            placeholder="Enter your APP_PASSWORD"
            required
          />

          <button
            className="sync-button"
            disabled={loading}
          >
            {loading ? "Checking..." : "Sign in"}
          </button>

          {error && <p className="error-text">{error}</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="app">

      {/* Sidebar */}
      <aside className="sidebar">

        <div className="brand">
          <div className="brand-icon">
            <ShieldCheck size={27} />
          </div>

          <div>
            <h2>Dispute Defender</h2>
            <span>AI SELLER ASSISTANT</span>
          </div>
        </div>

        <p className="menu-label">WORKSPACE</p>

        <button
          className={`menu ${page === "dashboard" ? "active" : ""}`}
          onClick={() => {
            setPage("dashboard");
            setSelectedDispute(null);
          }}
        >
          <LayoutDashboard size={19} />
          Dashboard
        </button>

        <button
          className={`menu ${page === "disputes" ? "active" : ""}`}
          onClick={() => {
            setPage("disputes");
            setSelectedDispute(null);
          }}
        >
          <Package size={19} />
          Disputes
        </button>

        <button
          className={`menu ${page === "ai" ? "active" : ""}`}
          onClick={() => {
            setAIStatus(null);
            setPage("ai");
            setSelectedDispute(null);
          }}
        >
          <Sparkles size={19} />
          AI Assistant
        </button>

        <div className="sidebar-bottom">
          <ShieldCheck size={18} />
          <span>Seller-controlled decisions</span>
        </div>

        <button
          className="logout-button"
          onClick={logout}
        >
          <LogOut size={16} />
          Sign out
        </button>

      </aside>

      {/* Main content */}
      <main className="main">

        {error && (
          <div className="notice error-notice">
            <AlertCircle size={18} />
            {error}
          </div>
        )}

        {syncError && !error && (
          <div className="notice error-notice" role="status">
            <AlertCircle size={18} />
            PayPal sync failed: {syncError}
          </div>
        )}

        {message && (
          <div className="notice">
            <CheckCircle size={18} />
            {message}
          </div>
        )}

        {/* Individual dispute details */}
        {selectedDispute ? (

          <section className="disputes-section">

            <button
              className="menu"
              onClick={() => {
                setSelectedDispute(null);
                setError("");
                setMessage("");
              }}
            >
              <ArrowLeft size={18} />
              Back to disputes
            </button>

            <section className="case-overview-card">
              <div className="case-overview-top">
                <div className="case-overview-identity">
                  <div className="case-brand-mark" aria-hidden="true">
                    <ShieldCheck size={26} />
                  </div>
                  <div>
                    <h1>Case #{selectedDispute.id}</h1>
                    <p>
                      {selectedDispute.reason.replaceAll("_", " ")}
                      <span className="case-meta-separator">•</span>
                      {selectedDispute.amount} {selectedDispute.currency}
                    </p>
                  </div>
                </div>
                {(() => {
                  const badge = getDisputeStatus(
                    selectedDispute.status,
                    Boolean(selectedDispute.submittedAt)
                  );
                  const StatusIcon = badge.icon;
                  return (
                    <span className={`status case-status-badge ${badge.className}`}>
                      <StatusIcon size={15} strokeWidth={2.5} />
                      {badge.label}
                    </span>
                  );
                })()}
              </div>

              {isCaseClosed(selectedDispute) ? (
                <div className={`case-resolution-card ${getOutcome(selectedDispute)}`}>
                  <div className="resolution-emblem">
                    {getOutcome(selectedDispute) === "seller-won"
                      ? <Trophy size={36} />
                      : getOutcome(selectedDispute) === "buyer-won"
                        ? <AlertCircle size={34} />
                        : <CheckCircle size={34} />}
                  </div>
                  <div className="resolution-copy">
                    <p className="eyebrow">CASE CLOSED</p>
                    <h2>
                      {getOutcome(selectedDispute) === "seller-won"
                        ? "Resolved in your favor"
                        : getOutcome(selectedDispute) === "buyer-won"
                          ? "Resolved in the buyer’s favor"
                          : "Dispute resolved"}
                    </h2>
                    <p>
                      {getOutcome(selectedDispute) === "seller-won"
                        ? "PayPal recorded an outcome in the seller’s favor."
                        : getOutcome(selectedDispute) === "buyer-won"
                          ? "PayPal recorded an outcome in the buyer’s favor."
                          : "PayPal marked this dispute as resolved. The outcome was not included in the available details."}
                      {selectedDispute.updatedAt
                        ? ` Closed ${formatUpdatedDate(selectedDispute.updatedAt)}.`
                        : ""}
                    </p>
                  </div>
                  <div className="resolution-decoration" aria-hidden="true">
                    <Trophy size={54} />
                  </div>
                </div>
              ) : null}

              <div className="case-timeline" aria-label="Dispute progress">
                {getTimelineSteps(selectedDispute).map((step, index) => (
                  <div
                    className={`timeline-step ${step.complete ? "complete" : ""} ${step.current ? "current" : ""}`}
                    key={step.label}
                  >
                    <div className="timeline-node">
                      {step.current
                        ? <Send size={16} />
                        : step.complete
                          ? <Check size={17} strokeWidth={3} />
                          : <Circle size={17} />}
                    </div>
                    {index < 4 && (
                      <div className={`timeline-connector ${step.complete ? "complete" : ""}`} />
                    )}
                    <strong>{step.label}</strong>
                    <span>{step.date}</span>
                  </div>
                ))}
              </div>

              <section className="response-workflow" aria-label="Dispute response workflow">
                <h2>Dispute response workflow</h2>
                <ol>
                  {workflowSteps.map((step, index) => (
                    <li
                      className={`response-workflow-step ${
                        step.complete
                          ? "complete"
                          : index === activeWorkflowStep
                            ? "current"
                            : ""
                      }`}
                      key={step.label}
                    >
                      <span className="response-workflow-number">
                        {step.complete ? <Check size={15} /> : index + 1}
                      </span>
                      <span>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>

              <div className="case-date-summary">
                <div>
                  <CalendarDays size={19} />
                  <span><strong>Created</strong>{formatUpdatedDate(selectedDispute.createdAt)}</span>
                </div>

                {selectedDispute.submissionAttempt?.status === "needs_review" && (
                  <div className="submission-review-notice">
                    <strong>Submission needs verification in PayPal</strong>
                    <p>
                      {selectedDispute.submissionAttempt.message ??
                        "The app could not confirm whether PayPal received the response."}
                      {" "}Do not retry unless you verified that PayPal did not accept it.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={reconcileConfirmed}
                        onChange={event => setReconcileConfirmed(event.target.checked)}
                      />
                      {" "}I checked PayPal and confirmed this response was not submitted.
                    </label>
                    <button
                      className="sync-button"
                      type="button"
                      disabled={!reconcileConfirmed || reconcilingSubmission}
                      onClick={handleReconcileSubmission}
                    >
                      {reconcilingSubmission ? "Updating..." : "Allow a new submission attempt"}
                    </button>
                  </div>
                )}
                <div>
                  <CheckCircle size={19} />
                  <span><strong>Responded</strong>{formatUpdatedDate(selectedDispute.submittedAt)}</span>
                </div>
                <div className={selectedDispute.dueDate ? "deadline-active" : ""}>
                  <CalendarDays size={19} />
                  <span><strong>Deadline</strong>{formatUpdatedDate(selectedDispute.dueDate)}</span>
                </div>
              </div>
            </section>

            <div className="case-role-note">
              <ShieldCheck size={18} />
              <p>
                <strong>Seller workspace:</strong> AI guidance is for the seller
                to review and, if appropriate, send to PayPal. This app does not
                contact or represent the buyer; PayPal determines the outcome.
              </p>
            </div>
            {selectedDispute.lifecycleStage &&
              ["CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"].includes(
                selectedDispute.lifecycleStage.toUpperCase()
              ) && (
                <div className="case-escalation-note">
                  This case is in the {selectedDispute.lifecycleStage.replaceAll("_", " ").toLowerCase()} stage.
                  Review PayPal’s case instructions for the appropriate seller
                  response. This app does not currently submit supporting
                  information for escalated stages.
                </div>
              )}

            <section className="evidence-comparison" aria-label="Buyer and seller evidence">
              <article className="evidence-party-panel buyer-evidence-panel">
                <div className="evidence-party-heading">
                  <div>
                    <p className="eyebrow">FROM PAYPAL</p>
                    <h2>Buyer evidence</h2>
                  </div>
                  <span className="evidence-count">
                    {selectedDispute.buyerEvidence?.length ?? 0}
                  </span>
                </div>
                {selectedDispute.buyerEvidence?.length ? (
                  <div className="evidence-party-list">
                    {selectedDispute.buyerEvidence.map((item, index) => (
                      <div className="evidence-item" key={`${item.type}-${index}`}>
                        <span className="evidence-type">
                          {item.type.replaceAll("_", " ")}
                        </span>
                        {item.details.length ? (
                          <ul>
                            {item.details.map((detail, detailIndex) => (
                              <li key={detailIndex}>{detail}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="evidence-muted">
                            PayPal included no readable text for this record.
                          </p>
                        )}
                        {item.documents.length > 0 && (
                          <div className="buyer-documents">
                            <strong>Attachments submitted by the buyer</strong>
                            {item.documents.map(document => (
                              <div
                                className="buyer-document-preview"
                                key={`${document.name}-${document.index}`}
                              >
                                <span>{document.name}</span>
                                {document.downloadable ? (
                                  <EvidenceImagePreview
                                    endpoint={`/api/disputes/${encodeURIComponent(selectedDispute.id)}/buyer-evidence/${index}/document/${document.index}/image`}
                                    password={password}
                                    alt={`Buyer attachment ${document.name}`}
                                  />
                                ) : (
                                  <p className="evidence-muted">
                                    PayPal did not provide a downloadable preview for this attachment.
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="evidence-empty">
                    PayPal returned no buyer evidence details visible to this seller account.
                    This does not confirm that the buyer submitted no evidence.
                  </p>
                )}
              </article>

              <article className="evidence-party-panel seller-evidence-panel">
                <div className="evidence-party-heading">
                  <div>
                    <p className="eyebrow">YOUR RECORDS</p>
                    <h2>Seller evidence</h2>
                  </div>
                  <span className="evidence-count">
                    {selectedDispute.evidence?.length ?? 0}
                  </span>
                </div>
                {selectedDispute.evidence?.length ? (
                  <div className="evidence-party-list">
                    {selectedDispute.evidence.map((item, index) => (
                      <div className="evidence-item" key={item.id ?? index}>
                        <span className="evidence-type">
                          {item.type.replaceAll("_", " ")}
                        </span>
                        <p>{item.text}</p>
                        {item.carrier && <p>Carrier: {item.carrier}</p>}
                        {item.trackingNumber && (
                          <p>Tracking number: {item.trackingNumber}</p>
                        )}
                        {item.imageFilename && (
                          <>
                            <p className="evidence-image-label">
                              <Image size={15} />
                              Image saved: {item.imageFilename}
                            </p>
                            <EvidenceImagePreview
                              endpoint={`/api/disputes/${encodeURIComponent(selectedDispute.id)}/evidence/${item.id}/image`}
                              password={password}
                              alt={`Seller evidence: ${item.imageFilename}`}
                            />
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="evidence-empty">
                    No seller evidence has been added to this case yet.
                  </p>
                )}
              </article>
            </section>

            <section className="disputes-section">
              <h2>Buyer-submitted evidence from PayPal</h2>
              {selectedDispute.buyerEvidence?.length ? (
                <>
                  {selectedDispute.buyerEvidence.map((item, index) => (
                    <div className="stat-card" key={`${item.type}-${index}`}>
                      <h3>{item.type.replaceAll("_", " ")}</h3>
                      {item.details.length ? (
                        <ul>
                          {item.details.map((detail, detailIndex) => (
                            <li key={detailIndex}>{detail}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No readable text was included in this PayPal record.</p>
                      )}
                      {item.documents.length > 0 && (
                        <p>
                          Attachments: {item.documents.join(", ")}. The AI
                          receives these names only; it does not read the
                          attachment contents.
                        </p>
                      )}
                    </div>
                  ))}
                  <p>
                    Buyer-provided statements are treated as claims, not
                    independently verified facts.
                  </p>
                </>
              ) : (
                <p>
                  PayPal did not provide any buyer-submitted evidence details
                  for this dispute.
                </p>
              )}
            </section>

            {!isCaseClosed(selectedDispute) && (
            <>
            {/* Add evidence form */}
            <section className="evidence-editor">

              <div className="evidence-editor-header">
                <div>
                  <h2>Add supporting evidence</h2>
                  <p>
                    Add your records here. They will be shown separately from buyer evidence.
                  </p>
                </div>

                <button className="icon-button" type="button" aria-label="Add evidence">
                  <Plus size={30} />
                </button>
              </div>

              <div className="evidence-card">
                <div className="evidence-row evidence-row-top">
                  <label className="field-label">Evidence type</label>

                  <select
                    className="field-input"
                    value={evidenceType}
                    onChange={e => setEvidenceType(e.target.value)}
                  >
                    <option value="tracking">
                      Tracking information
                    </option>

                    <option value="note">
                      Supporting note
                    </option>
                    <option value="invoice">
                      Invoice or proof of sale
                    </option>
                    <option value="message">
                      Buyer or seller communication
                    </option>
                  </select>
                </div>

                {evidenceType === "tracking" && (
                  <div className="evidence-row evidence-row-split">
                    <div className="field-group">
                      <label className="field-label">Shipping carrier</label>

                      <input
                        className="field-input"
                        type="text"
                        placeholder="Example: FedEx, DHL, UPS"
                        value={carrier}
                        onChange={e => setCarrier(e.target.value)}
                      />
                    </div>

                    <div className="field-group">
                      <label className="field-label">Tracking number</label>

                      <input
                        className="field-input"
                        type="text"
                        placeholder="Enter tracking number"
                        value={trackingNumber}
                        onChange={e => setTrackingNumber(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div className="evidence-row">
                  <label className="field-label">Evidence description</label>

                  <textarea
                    className="field-textarea"
                    placeholder="Describe the evidence and how it supports this dispute..."
                    value={evidenceText}
                    onChange={e => setEvidenceText(e.target.value)}
                    rows={5}
                  />
                </div>

                <div className="evidence-row evidence-image-field">
                  <span className="field-label">Evidence image</span>
                  <input
                    id="evidence-image-upload"
                    ref={evidenceImageInputRef}
                    className="visually-hidden"
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={event => {
                      const file = event.target.files?.[0] ?? null;
                      if (file && !["image/jpeg", "image/png"].includes(file.type)) {
                        setError("Choose a JPEG or PNG image.");
                        event.target.value = "";
                        setEvidenceImage(null);
                        return;
                      }
                      if (file && file.size > 5 * 1024 * 1024) {
                        setError("Evidence image must be 5 MB or smaller.");
                        event.target.value = "";
                        setEvidenceImage(null);
                        return;
                      }

                      setError("");
                      setEvidenceImage(file);
                    }}
                    disabled={savingEvidence}
                  />
                  <label
                    className="evidence-image-picker"
                    htmlFor="evidence-image-upload"
                  >
                    <Upload size={19} />
                    <span>
                      <strong>
                        {evidenceImage ? "Choose a different image" : "Choose an image"}
                      </strong>
                      <small>Browse your device · JPEG or PNG · up to 5 MB</small>
                    </span>
                  </label>
                  {evidenceImage && (
                    <div className="selected-upload">
                      <span>
                        {evidenceImage.name} · {(evidenceImage.size / 1024 / 1024).toFixed(2)} MB
                      </span>
                      <button
                        type="button"
                        className="remove-upload"
                        onClick={() => {
                          setEvidenceImage(null);
                          if (evidenceImageInputRef.current) {
                            evidenceImageInputRef.current.value = "";
                          }
                        }}
                        disabled={savingEvidence}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                <div className="evidence-actions">
                  <button
                    className="primary-button"
                    onClick={handleAddEvidence}
                    disabled={savingEvidence}
                    type="button"
                  >
                    <Plus size={17} />
                    {savingEvidence
                      ? "Saving evidence..."
                      : "Save evidence"}
                  </button>
                </div>

              </div>

            </section>

            {/* PayPal requested evidence */}
            <section className="disputes-section">
              <h2>PayPal requested evidence</h2>
              <p>Submission is enabled after the latest evidence has been analyzed.</p>

              {selectedDispute.requestedEvidence?.length ? (
                selectedDispute.requestedEvidence.map((request, index) => (
                  <div className="stat-card" key={`${request.paypalEvidenceType}-${index}`}>
                    <strong>{request.paypalEvidenceType.replaceAll("_", " ")}</strong>
                    <p>
                      Status:{" "}
                      {request.status === "available"
                        ? "Available"
                        : request.status === "needs_verification"
                          ? "Needs Verification"
                          : "Missing"}
                    </p>
                    {request.notes && <p>{request.notes}</p>}
                    {request.verificationRequired && (
                      <p>Seller verification is required; matching evidence does not confirm delivery.</p>
                    )}
                    {request.status !== "missing" && (
                      <button
                        className="sync-button"
                        type="button"
                        disabled={
                          Boolean(selectedDispute.submittedAt) ||
                          isCaseClosed(selectedDispute) ||
                          !selectedDispute.analysis
                        }
                        onClick={() => {
                          setSubmissionEvidenceType(request.paypalEvidenceType);
                          setSubmissionDraft(
                            selectedDispute.analysis?.draft ?? ""
                          );
                          setSubmissionConfirmed(false);
                        }}
                      >
                        {isCaseClosed(selectedDispute)
                          ? "Case closed"
                          : selectedDispute.submittedAt
                          ? "Submitted to PayPal"
                          : selectedDispute.analysis
                            ? "Review and submit"
                            : "Analyze evidence first"}
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p>No evidence requests from PayPal are recorded for this dispute.</p>
              )}
            </section>

            {submissionEvidenceType &&
              !isCaseClosed(selectedDispute) &&
              !selectedDispute.submittedAt && (
              <section className="disputes-section">
                <h2>Review and approve response</h2>
                <p>Submitting: {submissionEvidenceType.replaceAll("_", " ")}</p>
                <p>Review the AI draft below, edit it to match verified facts, then approve submission.</p>
                <label>Response to PayPal</label>
                <textarea
                  value={submissionDraft}
                  onChange={event => {
                    setSubmissionDraft(event.target.value);
                    setSubmissionConfirmed(false);
                  }}
                  rows={5}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={submissionConfirmed}
                    onChange={event =>
                      setSubmissionConfirmed(event.target.checked)
                    }
                  />
                  {" "}I reviewed the AI analysis and draft, edited the response as needed, and confirm the evidence is accurate and complete.
                </label>
                <button
                  className="sync-button"
                  type="button"
                  onClick={handleSubmitEvidence}
                  disabled={
                    submittingEvidence ||
                    !selectedDispute.analysis ||
                    !submissionConfirmed ||
                    !submissionDraft.trim()
                  }
                >
                  {submittingEvidence
                    ? "Submitting..."
                    : "Submit evidence to PayPal"}
                </button>
              </section>
            )}

            {/* Evidence analysis */}
            <section className="disputes-section">

              <div className="analysis-heading">
                <div>
                  <p className="eyebrow">AI-ASSISTED REVIEW</p>
                  <h2>Evidence analysis</h2>
                </div>
                <span className="analysis-disclaimer">
                  Review before relying on it
                </span>
              </div>

              {selectedDispute.analysis ? (

                <>
                  <div className="analysis-summary">
                    <div className="analysis-score">
                      <strong>{selectedDispute.analysis.strength}%</strong>
                      <span>Evidence completeness</span>
                    </div>
                    <div>
                      <h3>Case summary</h3>
                      <p>
                        {selectedDispute.analysis.summary ??
                          selectedDispute.analysis.why}
                      </p>
                      <p className="analysis-score-note">
                        Completeness is not a prediction of the dispute outcome.
                      </p>
                    </div>
                  </div>

                  <div className="analysis-findings-grid">
                    <article className="analysis-finding">
                      <h3>Buyer claims</h3>
                      {selectedDispute.analysis.buyerClaims?.length ? (
                        <ul>
                          {selectedDispute.analysis.buyerClaims.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No buyer-claim analysis is available. Re-run the analysis.</p>
                      )}
                    </article>
                    <article className="analysis-finding">
                      <h3>Seller evidence review</h3>
                      {selectedDispute.analysis.sellerEvidenceAssessment?.length ? (
                        <ul>
                          {selectedDispute.analysis.sellerEvidenceAssessment.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No seller-evidence assessment is available. Re-run the analysis.</p>
                      )}
                    </article>
                    <article className="analysis-finding">
                      <h3>Conflicts and comparison</h3>
                      {selectedDispute.analysis.conflicts?.length ? (
                        <ul>
                          {selectedDispute.analysis.conflicts.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No comparison is available. Re-run the analysis.</p>
                      )}
                    </article>
                    <article className="analysis-finding">
                      <h3>Recommended next steps</h3>
                      {selectedDispute.analysis.recommendedActions?.length ? (
                        <ol>
                          {selectedDispute.analysis.recommendedActions.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ol>
                      ) : (
                        <p>No next steps are available. Re-run the analysis.</p>
                      )}
                    </article>
                  </div>

                  <div className="analysis-missing">
                    <h3>Evidence gaps to address</h3>
                    {selectedDispute.analysis.missing.length ? (
                      <ul>
                        {selectedDispute.analysis.missing.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>No evidence gaps were identified. Verify this with the original records.</p>
                    )}
                  </div>

                  <div className="analysis-draft">
                    <h3>Draft for seller review</h3>
                    <p>{selectedDispute.analysis.draft}</p>
                  </div>
                </>

              ) : (

                <p>
                  {selectedDispute.evidence.length === 0
                    ? "Add seller evidence before requesting AI analysis."
                    : "This dispute has not been analyzed yet. Analyze the current dispute details and evidence when ready."}
                </p>

              )}

              <button
                className="sync-button"
                type="button"
                onClick={handleAnalyze}
                disabled={analyzing || selectedDispute.evidence.length === 0}
              >
                <Sparkles size={17} />
                {analyzing
                  ? "Analyzing dispute..."
                  : selectedDispute.analysis
                    ? "Run analysis again"
                    : "Analyze evidence"}
              </button>

            </section>
            </>
            )}

          </section>

        ) : page === "ai" ? (

          /* AI Assistant page */
          <>
            <header className="header">
              <div>
                <p className="eyebrow">AI WORKSPACE</p>
                <h1>AI Assistant</h1>

                <p className="subtitle">
                  Review the analysis status of your disputes.
                </p>
              </div>
            </header>

            <section className="disputes-section">

              <h2>Local AI status</h2>

              <div className={`ai-status-card ${aiStatus?.available ? "ready" : "unavailable"}`}>
                <div className="ai-status-indicator" />
                <div>
                  <h3>
                    {aiStatusLoading
                      ? "Checking local model..."
                      : aiStatus?.available
                        ? "AI model ready"
                        : "AI model not ready"}
                  </h3>
                  <p>
                    {aiStatus?.provider ?? "Ollama"} · Model:{" "}
                    {aiStatus?.model ?? "qwen2.5:7b"}
                  </p>
                  <p>
                    {aiStatusLoading
                      ? "Checking the local Ollama service and installed model."
                      : aiStatus?.message ?? "Status has not been checked yet."}
                  </p>
                  {!aiStatusLoading && !aiStatus?.available && (
                    <p className="ai-setup-hint">
                      Install Ollama, start its local service, and pull the model shown above.
                      No paid API key is required.
                    </p>
                  )}
                </div>
              </div>

              <h2 className="ai-overview-heading">Analysis overview</h2>

              <p>
                {disputes.filter(d => d.analysis).length} of{" "}
                {disputes.length} disputes have analysis results.
              </p>

              <p>
                Open a dispute to review its analysis, missing evidence,
                and suggested response.
              </p>

            </section>
          </>

        ) : (

          /* Dashboard and disputes list */
          <>
            <header className="header">

              <div>
                <p className="eyebrow">
                  {page === "dashboard" ? "OVERVIEW" : "WORKSPACE"}
                </p>

                <h1>
                  {page === "dashboard"
                    ? "Dispute Dashboard"
                    : "Disputes"}
                </h1>

                <p className="subtitle">
                  Monitor your actual PayPal disputes.
                </p>
              </div>

              <div className="sync-controls">
                <button
                  className="sync-button"
                  onClick={handleSync}
                  disabled={syncing}
                >
                  <RefreshCw size={17} className={syncing ? "syncing-icon" : ""} />
                  {syncing ? "Syncing..." : "Sync PayPal"}
                </button>
                <span className="sync-status" aria-live="polite">
                  {lastSyncedAt
                    ? `Last synced ${lastSyncedAt.toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit"
                      })} · auto-sync every 5 min`
                    : "Auto-sync every 5 min"}
                </span>
              </div>

            </header>

            {page === "dashboard" && (
              <section className="hero">
                <div className="hero-copy">
                  <p>PAYPAL DISPUTE MANAGEMENT</p>
                  <h2>Protect your business with smarter evidence.</h2>
                  <span>
                    Review disputes, identify missing evidence, and prepare
                    professional responses with AI support.
                  </span>
                </div>
                <div className="hero-icon" aria-hidden="true">
                  <ShieldCheck size={52} strokeWidth={1.8} />
                </div>
              </section>
            )}

            <section className="disputes-section">

              <div className="case-list-heading">

                <div>
                  <h2>
                    Your Disputes ({disputes.length})
                  </h2>
                  <p>
                    Review case status and open a dispute for details.
                  </p>
                </div>

                <div className="case-list-controls">
                  <div className="search-box">
                    <Search size={17} />
                    <input
                      placeholder="Search disputes..."
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />
                  </div>
                  <label className="status-filter">
                    <Filter size={15} aria-hidden="true" />
                    <span className="visually-hidden">Filter by dispute status</span>
                    <select
                      value={statusFilter}
                      onChange={event =>
                        setStatusFilter(event.target.value as DisputeStatusFilter)
                      }
                    >
                      <option value="all">All Statuses</option>
                      <option value="needs-response">Needs Response</option>
                      <option value="waiting-for-buyer">Waiting for Buyer</option>
                      <option value="under-review">Under Review</option>
                      <option value="response-submitted">Response Submitted</option>
                      <option value="resolved">Resolved</option>
                    </select>
                    <ChevronDown size={16} aria-hidden="true" />
                  </label>
                </div>

              </div>

              <div className="table-container">

                <table>
                  <thead>
                    <tr>
                      <th>Case ID</th>
                      <th>Reason</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Updated</th>
                      <th aria-label="Open dispute" />
                    </tr>
                  </thead>

                  <tbody>

                    {filtered.map(item => (
                      <tr
                        key={item.id}
                        onClick={() => openDispute(item)}
                        onKeyDown={event => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openDispute(item);
                          }
                        }}
                        tabIndex={0}
                        className="case-row"
                        title="Click to view dispute details"
                      >
                        <td>
                          <span className="case-id">{item.id}</span>
                        </td>

                        <td>
                          {item.reason.replaceAll("_", " ")}
                        </td>

                        <td>
                          {item.amount} {item.currency}
                        </td>

                        <td>
                          {(() => {
                            const badge = getDisputeStatus(
                              item.status,
                              Boolean(item.submittedAt)
                            );
                            const StatusIcon = badge.icon;
                            return (
                              <span className={`status ${badge.className}`}>
                                <StatusIcon size={14} strokeWidth={2.5} />
                                {badge.label}
                              </span>
                            );
                          })()}
                        </td>

                        <td>
                          {formatUpdatedDate(item.updatedAt)}
                        </td>

                        <td className="case-open-cell">
                          <ChevronRight size={19} aria-hidden="true" />
                        </td>
                      </tr>
                    ))}

                    {!filtered.length && (
                      <tr>
                        <td colSpan={6}>
                          No disputes loaded yet. Select Sync PayPal to load your disputes.
                        </td>
                      </tr>
                    )}

                  </tbody>
                </table>

              </div>

            </section>

            {page === "dashboard" && (
              <section className="notice">
                <AlertCircle size={19} />

                <div>
                  <strong>Seller-controlled dispute workflow</strong>

                  <p>
                    Sync disputes, add evidence, and request AI analysis when
                    you are ready. Responses are submitted only after you
                    review and approve them.
                  </p>
                </div>
              </section>
            )}

          </>
        )}

      </main>

      {selectedDispute && (
        <div className="dispute-bot-widget">
          {botPanelOpen && (
            <section
              className="dispute-bot-panel"
              aria-label={`AI assistant for case ${selectedDispute.id}`}
            >
              <header className="dispute-bot-header">
                <div className="dispute-bot-avatar">
                  <Bot size={21} />
                </div>
                <div>
                  <strong>AI assistant</strong>
                  <span>Case #{selectedDispute.id}</span>
                </div>
                <button
                  type="button"
                  className="dispute-bot-close"
                  aria-label="Close AI assistant"
                  onClick={() => setBotPanelOpen(false)}
                >
                  <X size={18} />
                </button>
              </header>

              <div className="dispute-bot-content">
                {assistantStatusError && (
                  <p className="dispute-bot-alert">
                    AI status unavailable: {assistantStatusError}
                  </p>
                )}

                <div className="dispute-bot-status">
                  <span className={`bot-status-dot ${
                    !assistantStatus
                      ? ""
                      : assistantStatus.available
                        ? "online"
                        : "offline"
                  }`} />
                  <div>
                    <strong>
                      {!assistantStatus
                        ? "Checking AI availability…"
                        : assistantStatus.available
                          ? "AI evidence analysis is ready"
                          : "AI evidence analysis is unavailable"}
                    </strong>
                    <p>
                      {assistantStatus?.message ??
                        "Checking the backend and local AI model…"}
                    </p>
                  </div>
                </div>

                <div className="dispute-bot-policy">
                  <span>Seller approval</span>
                  <strong>Required for every submission</strong>
                  <p>AI analysis and drafts never submit evidence to PayPal on their own.</p>
                </div>

                <div className="dispute-bot-draft">
                  <strong>Case response</strong>
                  <p>
                    The approved response submits formal evidence to PayPal;
                    it does not send a chat message to the buyer.
                  </p>
                  {selectedDispute.analysis ? (
                    <p>{selectedDispute.analysis.draft}</p>
                  ) : (
                    <p>No AI draft is saved for this case yet. Add evidence and request analysis when ready.</p>
                  )}
                  <button
                    type="button"
                    className="dispute-bot-action"
                    disabled={
                      analyzing ||
                      !assistantStatus?.available ||
                      selectedDispute.evidence.length === 0
                    }
                    onClick={() => void handleAnalyze()}
                  >
                    <Sparkles size={16} />
                    {analyzing
                      ? "Analyzing…"
                      : selectedDispute.analysis
                        ? "Refresh AI analysis"
                        : "Analyze evidence"}
                  </button>
                  {selectedDispute.analysis && (
                    <button
                      type="button"
                      className="dispute-bot-copy"
                      onClick={() => void handleCopyBotDraft()}
                    >
                      <Copy size={15} />
                      Copy draft
                    </button>
                  )}
                </div>

                {selectedDispute.submissionAttempt && (
                  <p className={`dispute-bot-attempt ${selectedDispute.submissionAttempt.status}`}>
                    {selectedDispute.submissionAttempt.message}
                  </p>
                )}
              </div>
            </section>
          )}

          <button
            type="button"
            className={`dispute-bot-launcher ${botPanelOpen ? "open" : ""}`}
            aria-expanded={botPanelOpen}
            onClick={() => {
              if (!botPanelOpen) setAssistantStatus(null);
              setBotPanelOpen(open => !open);
            }}
          >
            {botPanelOpen ? <X size={19} /> : <Bot size={20} />}
            {botPanelOpen ? "Close assistant" : "AI assistant"}
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
