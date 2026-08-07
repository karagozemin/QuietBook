import { Activity, ArrowLeft, ArrowUpRight, BadgeCheck, Check, Clock3, Download, Fingerprint, Plus, Radio, RefreshCw, ShieldCheck, Timer, Trophy, Upload, Users, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { latestTestnetLedger, type WalletSession } from "./wallet";
import { compact, explorerTransaction } from "./evidence";
import {
  createSandboxRound,
  exportConfidentialKeyBackup,
  hasSandboxDelegation,
  importConfidentialKeyBackup,
  listSandboxRounds,
  reclaimSandboxBid,
  settleSandboxRound,
  submitSandboxBid,
  type BidStage,
  type CreateRoundStage,
  type SandboxRound,
} from "./sandbox";

type ActionState =
  | { status: "idle" }
  | { status: "loading"; label: string }
  | { status: "success"; label: string; hash?: string }
  | { status: "error"; label: string };

const createRoundSteps: Array<{ id: CreateRoundStage; label: string; detail: string }> = [
  { id: "account", label: "Secure account", detail: "Checking confidential identity" },
  { id: "controller", label: "Prepare controller", detail: "Deploying isolated controller" },
  { id: "approval", label: "Approve once", detail: "Waiting for Freighter" },
  { id: "confirmation", label: "Confirm on Testnet", detail: "Waiting for ledger inclusion" },
  { id: "activation", label: "Publish round", detail: "Updating live evidence" },
];

const bidSteps: Array<{ id: BidStage; label: string; detail: string }> = [
  { id: "validation", label: "Check round", detail: "Reading bid deadline" },
  { id: "account", label: "Secure account", detail: "Checking confidential identity" },
  { id: "access", label: "Verify access", detail: "Applying round policy" },
  { id: "balance", label: "Sync balance", detail: "Matching private state" },
  { id: "proof", label: "Build sealed bid", detail: "Generating private proof" },
  { id: "transaction", label: "Prepare transaction", detail: "Simulating atomic bid" },
  { id: "approval", label: "Approve bid", detail: "Waiting for Freighter" },
  { id: "confirmation", label: "Confirm on Testnet", detail: "Waiting for ledger inclusion" },
  { id: "evidence", label: "Seal evidence", detail: "Publishing private receipt" },
];

const durationOptions = [2, 10, 30, 60, 180] as const;
const LEDGER_SECONDS = 5;
const SELECTED_ROUND_KEY = "quietbook:live:selected-round";

function countdown(deadline: number, ledger: number | null, ledgerReadAt: number, now: number) {
  if (ledger === null) return "Syncing";
  const elapsed = Math.max(0, Math.floor((now - ledgerReadAt) / 1_000));
  const seconds = Math.max(0, ((deadline - ledger) * LEDGER_SECONDS) - elapsed);
  if (seconds === 0) return "Unlocked";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function TransactionProgress({ stage, steps, title, label, error }: {
  stage: string;
  steps: Array<{ id: string; label: string; detail: string }>;
  title: string;
  label: string;
  error?: string;
}) {
  const activeIndex = steps.findIndex((step) => step.id === stage);
  const progress = ((activeIndex + 0.55) / steps.length) * 100;
  const stoppedTitle = stage === "approval"
    ? "WALLET APPROVAL STOPPED"
    : stage === "confirmation"
      ? "TESTNET CONFIRMATION STOPPED"
      : stage === "evidence"
        ? "EVIDENCE UPDATE STOPPED"
        : "BID STOPPED BEFORE APPROVAL";
  return (
    <section className={`live-create-progress ${error ? "failed" : ""}`} aria-live="polite" aria-label={label}>
      <div className="live-progress-head">
        <span>{error ? <Radio size={15}/> : <Activity className="spin" size={15}/>} {error ? stoppedTitle : title}</span>
        <b>{activeIndex + 1} / {steps.length}</b>
      </div>
      <div className="live-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={activeIndex + 1}>
        <span style={{ width: `${progress}%` }}/>
      </div>
      <div className={`live-progress-steps ${steps.length > 5 ? "wide" : ""}`}>
        {steps.map((step, index) => (
          <div key={step.id} className={index < activeIndex ? "complete" : index === activeIndex ? "active" : ""}>
            <span>{index < activeIndex ? <Check size={13}/> : index + 1}</span>
            <div><strong>{step.label}</strong><small>{index < activeIndex ? "Completed" : step.detail}</small></div>
          </div>
        ))}
      </div>
      {error && <div className="live-progress-error"><strong>{steps[activeIndex]?.label ?? "Bid preparation"} could not finish</strong><span>{error}</span></div>}
      {error?.includes("different key") && <div className="legacy-key-guide">
        <strong>Legacy wallet recovery</strong>
        <span>1. Open the browser/origin that first created this confidential account and click the Download icon beside the wallet address.</span>
        <span>2. Return here, click the Upload icon, and choose the encrypted backup file.</span>
        <span>3. Retry the bid after import completes.</span>
      </div>}
    </section>
  );
}

function CreateRoundProgress({ stage }: { stage: CreateRoundStage }) {
  return <TransactionProgress stage={stage} steps={createRoundSteps} title="OPENING LIVE ROUND" label="Live round creation progress"/>;
}

function BidProgress({ stage, error }: { stage: BidStage; error?: string }) {
  return <TransactionProgress stage={stage} steps={bidSteps} title="SEALING CONFIDENTIAL BID" label="Confidential bid progress" error={error}/>;
}

function SettlementResult({ round, session, hasBid, busy, onReclaim, onNewRound }: {
  round: SandboxRound;
  session?: WalletSession;
  hasBid: boolean;
  busy: boolean;
  onReclaim: () => void;
  onNewRound: () => void;
}) {
  const won = session?.address === round.winner;
  const lost = Boolean(session && hasBid && !won);
  const winnerLabel = won ? "Your wallet" : compact(round.winner ?? "", 7, 5);
  return (
    <div className={`live-result ${won ? "winner" : ""}`} role="status" aria-live="polite">
      {won && <div className="live-result-confetti" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <i key={index}/>)}</div>}
      <span className="live-result-mark">{won ? <Trophy size={26}/> : <BadgeCheck size={26}/>}</span>
      <span className="section-kicker">{won ? "WINNING WALLET" : "SETTLEMENT COMPLETE"}</span>
      <h2>{won ? "Your sealed bid won" : lost ? "Another bid won" : "Winner selected"}</h2>
      <p>{won
        ? "The max-bid proof selected your wallet and settlement completed atomically on Testnet."
        : lost
          ? "The max-bid proof selected a different wallet. Your bid value remains private and can now be reclaimed."
          : "The max-bid proof selected the winning wallet and settlement completed atomically on Testnet."}</p>
      <div className="live-result-facts">
        <span><small>Winner</small><strong>{winnerLabel}</strong></span>
        <span><small>Bids evaluated</small><strong>{round.bidders.length}</strong></span>
        <span><small>Winning amount</small><strong>Confidential</strong></span>
        <span><small>Max-bid proof</small><strong>{round.proof ? `${round.proof.bytes.toLocaleString()} bytes` : "Verified"}</strong></span>
      </div>
      <div className="live-result-actions">
        {lost && <button type="button" className="pressable button-primary" onClick={onReclaim} disabled={busy}>{busy ? <Activity className="spin" size={16}/> : <Wallet size={16}/>} Reclaim bid</button>}
        {session && !hasBid && <button type="button" className="pressable button-secondary" onClick={onNewRound} disabled={busy}><Plus size={16}/> Create next round</button>}
        {round.receipts.finalize && <a className="pressable button-secondary" href={explorerTransaction(round.receipts.finalize)} target="_blank" rel="noreferrer">Settlement receipt <ArrowUpRight size={14}/></a>}
      </div>
    </div>
  );
}

export function LiveSandboxPage({ session, onConnect }: {
  session?: WalletSession;
  onConnect: () => void;
}) {
  const [rounds, setRounds] = useState<SandboxRound[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ status: "idle" });
  const [createStage, setCreateStage] = useState<CreateRoundStage | null>(null);
  const [bidStage, setBidStage] = useState<BidStage | null>(null);
  const [latestLedger, setLatestLedger] = useState<number | null>(null);
  const [ledgerReadAt, setLedgerReadAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(() => sessionStorage.getItem(SELECTED_ROUND_KEY));
  const [showCreate, setShowCreate] = useState(false);
  const [bidWindowMinutes, setBidWindowMinutes] = useState<number>(30);
  const [bid, setBid] = useState("12");
  const backupInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      setRounds(await listSandboxRounds());
      void latestTestnetLedger().then((ledger) => {
        setLatestLedger(ledger);
        setLedgerReadAt(Date.now());
      }).catch(() => undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Live sandbox unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (selectedRoundId) sessionStorage.setItem(SELECTED_ROUND_KEY, selectedRoundId);
    else sessionStorage.removeItem(SELECTED_ROUND_KEY);
  }, [selectedRoundId]);

  const activeRounds = useMemo(() => rounds.filter((item) => (
    !item.winner && (latestLedger === null || latestLedger <= item.settlementDeadlineLedger)
  )), [latestLedger, rounds]);
  const availableRounds = useMemo(() => {
    const relatedRounds = session
      ? rounds.filter((item) => item.issuer === session.address || item.bidders.includes(session.address))
      : [];
    return [...new Map([...activeRounds, ...relatedRounds].map((item) => [item.roundId, item])).values()]
      .slice(0, 8);
  }, [activeRounds, rounds, session]);
  const round = selectedRoundId ? availableRounds.find((item) => item.roundId === selectedRoundId) : undefined;
  const isIssuer = Boolean(session && round?.issuer === session.address);
  const hasBid = Boolean(session && round?.bidders.includes(session.address));
  const hasLocalDelegation = Boolean(session && round && hasSandboxDelegation(session.address, round.roundId));
  const settled = Boolean(round?.winner);
  const expired = Boolean(round && latestLedger !== null && latestLedger > round.bidDeadlineLedger);
  const unlockCountdown = round ? countdown(round.bidDeadlineLedger, latestLedger, ledgerReadAt, now) : "";
  const receipts = useMemo(() => round ? Object.entries(round.receipts).filter(([, hash]) => /^[0-9a-f]{64}$/i.test(hash)) : [], [round]);

  const exportBackup = async () => {
    if (!session) return onConnect();
    try {
      const encoded = await exportConfidentialKeyBackup(session);
      const blob = new Blob([encoded], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `quietbook-confidential-${session.address.slice(0, 8)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setAction({ status: "success", label: "Encrypted confidential key backup downloaded" });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Could not export confidential key" });
    }
  };

  const importBackup = async (file: File) => {
    if (!session) return;
    try {
      await importConfidentialKeyBackup(session, await file.text());
      setAction({ status: "success", label: "Confidential key imported. Retry the bid." });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Could not import confidential key" });
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  };

  const createRound = async () => {
    if (!session) return onConnect();
    const updateProgress = (stage: CreateRoundStage) => {
      const current = createRoundSteps.find((step) => step.id === stage)!;
      setCreateStage(stage);
      setAction({ status: "loading", label: current.detail });
    };
    updateProgress("account");
    try {
      const created = await createSandboxRound(session, bidWindowMinutes, updateProgress);
      setRounds((current) => [created, ...current.filter((item) => item.roundId !== created.roundId)]);
      setSelectedRoundId(created.roundId);
      setShowCreate(false);
      setCreateStage(null);
      setAction({ status: "success", label: "Live round opened", hash: created.receipts.createAndOpenRound });
    } catch (error) {
      setCreateStage(null);
      setAction({ status: "error", label: error instanceof Error ? error.message : "Round creation failed" });
    }
  };

  const beginCreate = () => {
    setSelectedRoundId(null);
    setBidStage(null);
    setAction({ status: "idle" });
    setShowCreate(true);
    if (!session) onConnect();
  };

  const selectRound = (roundId: string) => {
    setSelectedRoundId(roundId);
    setShowCreate(false);
    setBidStage(null);
    setAction({ status: "idle" });
  };

  const showDirectory = () => {
    setSelectedRoundId(null);
    setBidStage(null);
    setAction({ status: "idle" });
  };

  const placeBid = async () => {
    if (!session) return onConnect();
    if (!round) return;
    const updateProgress = (stage: BidStage) => {
      const current = bidSteps.find((step) => step.id === stage)!;
      setBidStage(stage);
      setAction({ status: "loading", label: current.detail });
    };
    updateProgress("validation");
    try {
      const result = await submitSandboxBid(session, round, BigInt(Math.round(Number(bid) * 10_000_000)), updateProgress);
      setBidStage(null);
      setAction({ status: "success", label: "Sealed bid confirmed", hash: result.registrationTransaction });
      await refresh();
    } catch (error) {
      console.error("Live bid stopped", error);
      setAction({ status: "error", label: error instanceof Error ? error.message : "Bid failed" });
    }
  };

  const settle = async () => {
    if (!round) return;
    if (!session) return onConnect();
    setAction({ status: "loading", label: "Closing book and generating maximum-bid proof" });
    try {
      const result = await settleSandboxRound(session, round.roundId);
      setRounds((current) => [result, ...current.filter((item) => item.roundId !== result.roundId)]);
      setAction({ status: "success", label: "Round settled atomically", hash: result.receipts.finalize });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Settlement failed" });
    }
  };

  const reclaim = async () => {
    if (!round || !session) return;
    setAction({ status: "loading", label: "Generating reclaim proof in this browser" });
    try {
      const result = await reclaimSandboxBid(session, round);
      setAction({ status: "success", label: "Losing bid reclaimed", hash: result.transaction });
    } catch (error) {
      setAction({ status: "error", label: error instanceof Error ? error.message : "Reclaim failed" });
    }
  };

  if (loading) {
    return <div className="workspace-page live-loading"><Activity className="spin" size={20}/> Reading live sandbox</div>;
  }

  return (
    <div className="workspace-page page-enter">
      <div className="page-title-row live-title-row">
        <div><span className="section-kicker">MULTI-WALLET TESTNET SANDBOX</span><h1>Live issuance</h1><p>New wallet signatures, new round receipts and a new settlement proof.</p></div>
        <div className="live-title-actions"><button type="button" className="pressable button-primary" onClick={beginCreate} disabled={action.status === "loading"}><Plus size={16}/> New issuance</button><button type="button" className="icon-pressable" onClick={() => void refresh()} aria-label="Refresh live rounds"><RefreshCw size={17}/></button></div>
      </div>

      {loadError && <div className="live-alert error"><Radio size={16}/><span><strong>Sandbox service unavailable</strong>{loadError}</span></div>}

      {!round ? (
        <section className="live-directory">
          <div className="live-directory-head"><div><span className="section-kicker">ACTIVE ROUNDS</span><h2>Choose an issuance</h2></div><span><Radio size={14}/>{activeRounds.length} live</span></div>

          {showCreate && <section className="live-round-create">
            <div className="live-create-heading"><div><span className="section-kicker">NEW ISSUANCE</span><h2>Set the bid window</h2></div><button type="button" className="icon-pressable" onClick={() => { setShowCreate(false); setCreateStage(null); setAction({ status: "idle" }); }} aria-label="Close round creation" disabled={action.status === "loading"}><Plus className="close-plus" size={17}/></button></div>
            {createStage ? <CreateRoundProgress stage={createStage}/> : <>
              <div className="live-duration-control"><span>BID WINDOW</span><div>{durationOptions.map((minutes) => <button type="button" key={minutes} className={bidWindowMinutes === minutes ? "active" : ""} onClick={() => setBidWindowMinutes(minutes)}><b>{minutes < 60 ? minutes : minutes / 60}</b><small>{minutes < 60 ? "MIN" : "HR"}</small></button>)}</div></div>
              <div className="live-create-summary"><span><Timer size={16}/> Settlement unlock</span><strong>in {durationLabel(bidWindowMinutes)}</strong><small>15 minute settlement grace follows the bid window</small></div>
              <button type="button" className="pressable button-primary button-large" onClick={() => void createRound()} disabled={action.status === "loading"}>{session ? <Plus size={17}/> : <Wallet size={17}/>} {session ? `Create ${durationLabel(bidWindowMinutes)} round` : "Connect issuer wallet"}</button>
            </>}
          </section>}

          {activeRounds.length > 0 ? <div className="live-round-grid">{activeRounds.map((item) => {
            const itemExpired = latestLedger !== null && latestLedger > item.bidDeadlineLedger;
            const itemCountdown = countdown(item.bidDeadlineLedger, latestLedger, ledgerReadAt, now);
            return <button type="button" className="live-round-card" key={item.roundId} onClick={() => selectRound(item.roundId)} aria-label={`Open round ${compact(item.roundId, 6, 4)} issued by ${compact(item.issuer)}`}>
              <span className="live-round-card-top"><b>{item.issuer === session?.address ? "YOUR ISSUANCE" : itemExpired ? "SETTLEMENT READY" : "OPEN ISSUANCE"}</b><code>QB / {compact(item.roundId, 6, 4)}</code></span>
              <span className="live-round-card-main"><strong>{itemExpired ? "Bidding closed" : itemCountdown}</strong><small>{itemExpired ? "Issuer can settle" : "until settlement unlock"}</small></span>
              <span className="live-round-card-meta"><span><Users size={14}/>{item.bidders.length}/3 bids</span><span><ShieldCheck size={14}/>{compact(item.issuer)}</span><ArrowUpRight size={16}/></span>
            </button>;
          })}</div> : !showCreate && <section className="live-empty"><span className="live-empty-icon"><Plus size={26}/></span><div><span className="section-kicker">NO ACTIVE ROUNDS</span><h2>Open the first issuance</h2><p>Choose a bid window and publish a new isolated Testnet round.</p></div><button type="button" className="pressable button-primary button-large" onClick={beginCreate}>{session ? <Plus size={17}/> : <Wallet size={17}/>} {session ? "New issuance" : "Connect issuer wallet"}</button></section>}
        </section>
      ) : (
        <>
          <div className="live-round-toolbar"><button type="button" className="pressable button-secondary" onClick={showDirectory}><ArrowLeft size={15}/> All active rounds</button><button type="button" className="pressable button-secondary" onClick={beginCreate}><Plus size={15}/> New issuance</button></div>
          <section className="live-round-band">
            <div className="live-round-identity"><span className="section-kicker">SELECTED ROUND · ISSUER {compact(round.issuer, 7, 5)}</span><h1>QB / {compact(round.roundId, 6, 4)}</h1><code>{round.roundId}</code></div>
            <div className="live-round-metrics">
              <div><span>Status</span><strong>{settled ? "Settled" : expired ? "Bid window closed" : "Open"}</strong></div>
              <div><span>Book</span><strong>{round.bidders.length} / 3 wallets</strong></div>
              <div><span>Settlement unlock</span><strong>{unlockCountdown}</strong></div>
            </div>
          </section>

          <div className="live-action-layout">
            <section className="live-primary-action">
              <div className="live-role-line"><span>{isIssuer ? <ShieldCheck size={17}/> : <Wallet size={17}/>} {isIssuer ? "ISSUER WALLET" : "INVESTOR WALLET"}</span><div className="live-role-account"><b>{session ? compact(session.address) : "Not connected"}</b>{session && <span className="live-key-tools"><button type="button" className="icon-pressable" onClick={() => void exportBackup()} aria-label="Export encrypted confidential key backup" title="Export encrypted confidential key backup"><Download size={14}/></button><button type="button" className="icon-pressable" onClick={() => backupInputRef.current?.click()} aria-label="Import encrypted confidential key backup" title="Import encrypted confidential key backup"><Upload size={14}/></button><input ref={backupInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBackup(file); }}/></span>}</div></div>
              {action.status === "loading" && createStage && <CreateRoundProgress stage={createStage}/>}
              {bidStage && <BidProgress stage={bidStage} error={action.status === "error" ? action.label : undefined}/>}
              {bidStage && action.status === "error" && <div className="live-progress-actions"><button type="button" className="pressable button-primary" onClick={() => void placeBid()}><RefreshCw size={15}/> Retry bid</button><button type="button" className="pressable button-secondary" onClick={() => { setBidStage(null); setAction({ status: "idle" }); }}>Edit amount</button></div>}
              {!createStage && !bidStage && <>
              {!session && <><h2>Connect a Testnet wallet</h2><p>Freighter signs the actions for this account.</p><button type="button" className="pressable button-primary" onClick={onConnect}><Wallet size={16}/> Connect wallet</button></>}
              {session && !settled && expired && round.bidders.length === 0 && <div className="live-complete expired"><Clock3 size={28}/><h2>Bid window closed</h2><p>{hasLocalDelegation ? "Your previous attempt created a confidential delegation before the deadline closed. Reclaim it before continuing." : "No bid was registered before the deadline. Start a fresh issuance with a new ledger window."}</p>{hasLocalDelegation ? <button type="button" className="pressable button-primary" onClick={() => void reclaim()} disabled={action.status === "loading"}>{action.status === "loading" ? <Activity className="spin" size={16}/> : <Wallet size={16}/>} Reclaim expired bid</button> : <button type="button" className="pressable button-primary" onClick={beginCreate} disabled={action.status === "loading"}><Plus size={16}/> Create next round</button>}</div>}
              {session && isIssuer && !settled && !expired && <><h2>{round.bidders.length < 3 ? "Collecting sealed bids" : "Book is ready"}</h2><p>{round.bidders.length < 3 ? `${3 - round.bidders.length} investor wallet${3 - round.bidders.length === 1 ? "" : "s"} remaining.` : "The book is full and remains sealed until the deadline."}</p><button type="button" className="pressable button-primary" disabled><Timer size={16}/> Settlement in {unlockCountdown}</button></>}
              {session && isIssuer && !settled && expired && round.bidders.length > 0 && <><h2>Book is ready to settle</h2><p>The bid window is closed. Generate the maximum-bid proof and settle the winner.</p><button type="button" className="pressable button-primary" onClick={() => void settle()} disabled={action.status === "loading"}>{action.status === "loading" ? <Activity className="spin" size={16}/> : <Fingerprint size={16}/>} Close & settle round</button></>}
              {session && !isIssuer && !settled && !expired && !hasBid && <><h2>Submit one confidential bid</h2><div className="bid-field"><label htmlFor="live-bid">YOUR BID</label><span><input id="live-bid" inputMode="decimal" value={bid} onChange={(event) => setBid(event.target.value.replace(/[^0-9.]/g, ""))}/><b>XLM</b></span><small>8.00 minimum · 20.00 maximum</small></div><button type="button" className="pressable button-primary button-large" onClick={() => void placeBid()} disabled={action.status === "loading"}>{action.status === "loading" ? <Activity className="spin" size={17}/> : <Fingerprint size={17}/>} Prove & sign sealed bid</button></>}
              {session && !isIssuer && !settled && expired && round.bidders.length > 0 && !hasBid && <div className="live-complete expired"><Clock3 size={28}/><h2>Bid window closed</h2><p>The issuer can now close the book and settle the proven winner.</p></div>}
              {session && !isIssuer && hasBid && !settled && <div className="live-complete"><BadgeCheck size={28}/><h2>Bid sealed on Testnet</h2><p>Your value stays in this browser and the operator’s private settlement vault.</p></div>}
              {settled && <SettlementResult round={round} session={session} hasBid={hasBid} busy={action.status === "loading"} onReclaim={() => void reclaim()} onNewRound={beginCreate}/>}
              </>}
            </section>

            <section className="live-book">
              <div className="live-book-head"><span>PARTICIPANTS</span><b>{round.bidders.length}/3</b></div>
              {[0, 1, 2].map((index) => {
                const account = round.bidders[index];
                const winner = settled && account === round.winner;
                return <div className={`live-bidder ${account ? "filled" : ""} ${winner ? "winner" : ""}`} key={index}><span>{winner ? <Trophy size={14}/> : account ? <Check size={14}/> : index + 1}</span><div><strong>{account ? account === session?.address ? "Your wallet" : `Investor ${String(index + 1).padStart(2, "0")}` : settled ? "Not filled" : "Available"}</strong><small>{account ? compact(account) : settled ? "Round settled" : "Waiting for wallet"}</small></div><b>{winner ? "WINNER" : settled && account ? "NOT SELECTED" : account ? "SEALED" : settled ? "CLOSED" : "OPEN"}</b></div>;
              })}
              <div className={`live-deadline ${expired ? "expired" : ""}`}><Timer size={15}/><span>{expired ? "Settlement unlocked" : "Settlement unlock"}<strong>{expired ? "Ready now" : unlockCountdown}</strong><small>Ledger {round.bidDeadlineLedger.toLocaleString()}</small></span></div>
            </section>
          </div>

          {receipts.length > 0 && <section className="live-receipts"><div className="live-book-head"><span>LIVE EVIDENCE</span><b>{receipts.length} RECEIPTS</b></div>{receipts.slice(-6).reverse().map(([label, hash]) => <a key={`${label}:${hash}`} href={explorerTransaction(hash)} target="_blank" rel="noreferrer"><span><BadgeCheck size={15}/><b>{label.replace(/([A-Z])/g, " $1")}</b></span><code>{compact(hash, 12, 8)}</code><ArrowUpRight size={15}/></a>)}</section>}
        </>
      )}

      {action.status !== "idle" && !bidStage && !(action.status === "loading" && createStage) && <div className={`live-alert ${action.status}`} role="status">{action.status === "loading" ? <Activity className="spin" size={16}/> : action.status === "success" ? <BadgeCheck size={16}/> : <Radio size={16}/>}<span><strong>{action.status === "loading" ? "Wallet flow active" : action.status === "success" ? "Confirmed" : "Action stopped"}</strong>{action.label}</span>{action.status === "success" && action.hash && <a href={explorerTransaction(action.hash)} target="_blank" rel="noreferrer">Receipt <ArrowUpRight size={13}/></a>}</div>}
    </div>
  );
}
