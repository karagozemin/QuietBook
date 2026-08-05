import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Ban,
  BookOpen,
  Braces,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCheck2,
  Fingerprint,
  KeyRound,
  Landmark,
  Link2,
  LockKeyhole,
  Network,
  PanelRightOpen,
  Play,
  RefreshCw,
  Scale,
  ShieldCheck,
  Square,
  Users,
  Wallet,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  compact,
  explorerContract,
  explorerTransaction,
  participants,
  testnetEvidence,
} from "./evidence";
import type { LiveSnapshot } from "./live";
import type { WalletSession } from "./wallet";

type Page = "round" | "evidence" | "contracts";
type Role = "public" | "issuer" | "investor" | "auditor";
type LiveState =
  | { status: "checking" }
  | { status: "verified" | "mismatch"; snapshot: LiveSnapshot }
  | { status: "fallback"; error: string };
type WalletState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; session: WalletSession; roundStatus: string }
  | { status: "error"; message: string };

type DemoStep = {
  label: string;
  detail: string;
  icon: typeof Eye;
  negative?: boolean;
};

const demoSteps: readonly DemoStep[] = [
  { label: "RWA lot escrowed", detail: "Fixed QBNOTE lot funded", icon: Landmark },
  { label: "Controller registered", detail: "Round-bound confidential account", icon: KeyRound },
  { label: "Three bids sealed", detail: "Values remain confidential", icon: LockKeyhole },
  { label: "Policy denial recorded", detail: "Unauthorized account rejected", icon: Ban, negative: true },
  { label: "Participant set frozen", detail: "Ordered set hash committed", icon: Users },
  { label: "Winner proven", detail: "Max-Bid statement matched", icon: Fingerprint },
  { label: "Settlement executed", detail: "Payment and RWA delivery atomic", icon: Scale },
  { label: "Evidence indexed", detail: "Testnet receipts available", icon: FileCheck2 },
];

const roles: Array<{ id: Role; label: string; icon: typeof Eye }> = [
  { id: "public", label: "Public", icon: Eye },
  { id: "issuer", label: "Issuer", icon: Landmark },
  { id: "investor", label: "Investor", icon: Users },
  { id: "auditor", label: "Auditor", icon: ShieldCheck },
];

const contracts = [
  ["Market", testnetEvidence.deployment.contracts.market],
  ["Round controller", { contractId: testnetEvidence.controller.controller }],
  ["Confidential token", testnetEvidence.deployment.contracts.confidentialToken],
  ["Max-Bid verifier", testnetEvidence.deployment.contracts.maxBidVerifier],
  ["Eligibility policy", testnetEvidence.deployment.contracts.eligibilityPolicy],
  ["RWA token", testnetEvidence.deployment.contracts.rwaToken],
  ["Confidential verifier", testnetEvidence.deployment.contracts.confidentialVerifier],
  ["Auditor registry", testnetEvidence.deployment.contracts.confidentialAuditor],
  ["Lifecycle market", { contractId: testnetEvidence.withdrawal.market }],
  ["Lifecycle controller", { contractId: testnetEvidence.withdrawal.controller }],
] as const;

function IconButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function StatusMark({ kind = "ok" }: { kind?: "ok" | "denied" | "hidden" }) {
  if (kind === "denied") return <Ban size={15} aria-hidden="true" />;
  if (kind === "hidden") return <EyeOff size={15} aria-hidden="true" />;
  return <Check size={15} aria-hidden="true" />;
}

function AppHeader({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true"><BookOpen size={20} /></div>
        <div>
          <strong>QuietBook</strong>
          <span>Issuance console</span>
        </div>
      </div>
      <nav className="main-nav" aria-label="Primary navigation">
        {(["round", "evidence", "contracts"] as Page[]).map((item) => (
          <button
            type="button"
            key={item}
            className={page === item ? "active" : ""}
            onClick={() => setPage(item)}
          >
            {item === "round" ? "Live round" : item[0]!.toUpperCase() + item.slice(1)}
          </button>
        ))}
      </nav>
      <div className="network-state">
        <span className="network-dot" />
        Stellar Testnet
      </div>
    </header>
  );
}

function LiveVerificationBar({ state, refresh }: { state: LiveState; refresh: () => void }) {
  const verified = state.status === "verified";
  const mismatch = state.status === "mismatch";
  const title = state.status === "checking"
    ? "Checking Testnet"
    : verified
      ? state.snapshot.indexer === "verified" ? "Indexer + RPC verified" : "Live RPC verified"
      : mismatch
        ? "Live mismatch detected"
        : "Evidence fallback active";
  const detail = state.status === "checking"
    ? "Reading market, controller and settlement state"
    : state.status === "fallback"
      ? "Public RPC unavailable · verified replay remains available"
      : `${state.snapshot.matchedCount}/${state.snapshot.checks.length} checks matched · ${state.snapshot.indexer === "verified" ? "durable event cache · " : "direct RPC · "}ledger ${state.snapshot.latestLedger.toLocaleString()}`;

  return (
    <div className={`live-verification ${state.status}`} role="status" title={state.status === "fallback" ? state.error : undefined}>
      <div className="live-verification-inner">
        <div className="live-verification-copy">
          <span className="live-icon" aria-hidden="true">
            {state.status === "checking" ? <Activity size={15}/> : verified ? <BadgeCheck size={15}/> : <Clock3 size={15}/>}
          </span>
          <div><strong>{title}</strong><span>{detail}</span></div>
        </div>
        {state.status !== "checking" && (
          <button type="button" className="live-refresh" onClick={refresh} aria-label="Refresh live verification" title="Refresh live verification">
            <RefreshCw size={15}/>
          </button>
        )}
      </div>
    </div>
  );
}

function RoundHeader({ onEvidence }: { onEvidence: () => void }) {
  return (
    <section className="round-heading">
      <div>
        <div className="eyebrow-row">
          <span className="role-banner">PUBLIC ROUND</span>
          <span className="status settled"><BadgeCheck size={14} /> Settled</span>
        </div>
        <h1>QBNOTE-26 <span>Demo issuance</span></h1>
        <p>Known investors. Private bids. Verifiable allocation.</p>
      </div>
      <div className="round-actions">
        <button className="secondary-button" type="button" onClick={onEvidence}>
          <PanelRightOpen size={17} /> Evidence
        </button>
        <a
          className="primary-button"
          href={testnetEvidence.settlement.explorer}
          target="_blank"
          rel="noreferrer"
        >
          Final transaction <ArrowUpRight size={17} />
        </a>
      </div>
    </section>
  );
}

function Metrics() {
  const metrics = [
    { label: "Public RWA lot", value: "1.0000000 QBNOTE", note: "Escrow delivered", icon: Landmark },
    { label: "Public reserve", value: "8.0000000 XLM", note: "Threshold met", icon: CircleDollarSign },
    { label: "Verified bidders", value: "3", note: "1 policy denial", icon: Users },
    { label: "Proof statement", value: "448 bytes", note: "Byte match", icon: Braces },
  ];
  return (
    <div className="metrics-grid">
      {metrics.map(({ label, value, note, icon: MetricIcon }) => (
        <div className="metric" key={label}>
          <div className="metric-label"><MetricIcon size={16} /> {label}</div>
          <strong>{value}</strong>
          <span>{note}</span>
        </div>
      ))}
    </div>
  );
}

function JudgeReplay({ stage, running, onRun, onStop }: {
  stage: number;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const activeLabel = stage === demoSteps.length ? "Verified run complete" : demoSteps[stage]?.label;
  return (
    <section className="workflow-band">
      <div className="workflow-toolbar">
        <div>
          <div className="section-kicker">JUDGE FLOW · TESTNET EVIDENCE REPLAY</div>
          <h2>{activeLabel}</h2>
        </div>
        <button className="replay-button" type="button" onClick={running ? onStop : onRun}>
          {running ? <Square size={16} /> : <Play size={16} />}
          {running ? "Stop replay" : stage === demoSteps.length ? "Replay verified run" : "Resume replay"}
        </button>
      </div>
      <div className="step-track" role="list" aria-label="Verified round steps">
        {demoSteps.map((step, index) => {
          const complete = index < stage || stage === demoSteps.length;
          const active = running && index === stage;
          const StepIcon = step.icon;
          return (
            <div className={`flow-step ${complete ? "complete" : ""} ${active ? "active" : ""}`} key={step.label} role="listitem">
              <div className={`step-node ${step.negative ? "negative" : ""}`}>
                {complete ? <Check size={16} /> : <StepIcon size={16} />}
              </div>
              <div>
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ParticipantsTable() {
  return (
    <section className="data-section participants-section">
      <div className="section-heading">
        <div>
          <div className="section-kicker">ORDERED PARTICIPANT SET</div>
          <h2>Registered investors</h2>
        </div>
        <span className="hash-chip" title={testnetEvidence.settlement.roundId}>
          <Fingerprint size={14} /> {compact(testnetEvidence.settlement.roundId, 8, 6)}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Index</th><th>Investor</th><th>Bid receipt</th><th>Result</th><th>Evidence</th></tr>
          </thead>
          <tbody>
            {participants.map((participant) => (
              <tr key={participant.account}>
                <td className="index-cell">{String(participant.registrationIndex).padStart(2, "0")}</td>
                <td>
                  <div className="identity-cell"><span className="identity-avatar">{participant.registrationIndex + 1}</span><div><strong>{participant.alias}</strong><span>{compact(participant.account)}</span></div></div>
                </td>
                <td><span className="sealed-state"><LockKeyhole size={14} /> Bid sealed</span></td>
                <td>{participant.winner ? <span className="winner-state"><BadgeCheck size={14} /> Winner</span> : participant.reclaimTransaction ? <span className="winner-state"><Check size={14} /> Reclaimed</span> : <span className="muted-state">Not allocated</span>}</td>
                <td><a className="table-link" href={explorerTransaction(participant.registrationTransaction)} target="_blank" rel="noreferrer" aria-label={`Open ${participant.alias} registration transaction`}><ArrowUpRight size={16} /></a></td>
              </tr>
            ))}
            <tr className="denied-row">
              <td className="index-cell">—</td>
              <td><div className="identity-cell"><span className="identity-avatar denied">4</span><div><strong>Unapproved applicant</strong><span>{compact(testnetEvidence.setup.rejectedAccount)}</span></div></div></td>
              <td><span className="denied-state"><Ban size={14} /> Policy denied</span></td>
              <td><span className="muted-state">Not registered</span></td>
              <td><span className="reason-code">4006</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RolePanel({
  role,
  setRole,
  wallet,
  connectWallet,
  disconnectWallet,
}: {
  role: Role;
  setRole: (role: Role) => void;
  wallet: WalletState;
  connectWallet: () => void;
  disconnectWallet: () => void;
}) {
  return (
    <section className="visibility-section">
      <div className="section-heading compact-heading">
        <div>
          <div className="section-kicker">CONFIDENTIALITY, NOT ANONYMITY</div>
          <h2>Role visibility</h2>
        </div>
        <div className="role-tabs" role="tablist" aria-label="Role view">
          {roles.map(({ id, label, icon: RoleIcon }) => (
            <button type="button" role="tab" aria-selected={role === id} className={role === id ? "active" : ""} key={id} onClick={() => setRole(id)}>
              <RoleIcon size={15} /> {label}
            </button>
          ))}
        </div>
      </div>
      <div className="visibility-grid">
        <div className="public-view">
          <div className="panel-label"><Eye size={15} /> PUBLIC MARKET VIEW</div>
          <div className="visibility-stat"><strong>3</strong><span>verified investors</span></div>
          <ul className="visibility-list">
            <li><span>Participant identities</span><StatusMark /></li>
            <li><span>Bid receipt states</span><StatusMark /></li>
            <li><span>Winner identity</span><StatusMark /></li>
            <li><span>Bid and payment values</span><span className="hidden-value"><EyeOff size={14} /> Hidden</span></li>
          </ul>
        </div>
        <div className="role-view">
          {role === "public" && <PublicRole />}
          {role === "issuer" && <IssuerRole wallet={wallet} connectWallet={connectWallet} disconnectWallet={disconnectWallet} />}
          {role === "investor" && <InvestorRole wallet={wallet} connectWallet={connectWallet} disconnectWallet={disconnectWallet} />}
          {role === "auditor" && <AuditorRole />}
        </div>
      </div>
    </section>
  );
}

function PublicRole() {
  return <><div className="panel-label"><Network size={15} /> PUBLIC PROCESS STATE</div><div className="state-stack"><StateRow label="Participant set" value="Frozen · 3 accounts"/><StateRow label="Winner proof" value="Verified" good/><StateRow label="Settlement" value="Complete" good/><StateRow label="RWA delivery" value="1.0000000 QBNOTE" good/></div></>;
}

function IssuerRole({ wallet, connectWallet, disconnectWallet }: WalletPanelProps) {
  const isIssuer = wallet.status === "connected" && wallet.session.address === testnetEvidence.deployment.roles.issuer;
  return <><div className="panel-label"><Landmark size={15} /> ISSUER VIEW</div><div className="state-stack"><StateRow label="Round terms" value="Immutable" good/><StateRow label="Escrow" value="Delivered" good/><StateRow label="Payment receipt" value="Confidential" hidden/><StateRow label="Finalization" value={compact(testnetEvidence.settlement.finalizeTransaction)}/></div><WalletPanel wallet={wallet} connectWallet={connectWallet} disconnectWallet={disconnectWallet} roleMessage={isIssuer ? "Issuer account verified" : wallet.status === "connected" ? "Connected account is not this round's issuer" : "Connect the issuer account to manage a writable round"}/></>;
}

function InvestorRole({ wallet, connectWallet, disconnectWallet }: WalletPanelProps) {
  const winner = participants.find((participant) => participant.winner)!;
  const participant = wallet.status === "connected" ? participants.find((item) => item.account === wallet.session.address) : undefined;
  const roleMessage = participant
    ? `${participant.alias} · ${participant.winner ? "winning delegation consumed" : "losing delegation reclaimed"}`
    : wallet.status === "connected"
      ? "Connected account did not participate in this round"
      : "Connect an investor account to load its private action state";
  return <><div className="panel-label"><Users size={15} /> INVESTOR VIEW</div><div className="state-stack"><StateRow label="Selected account" value={participant?.alias ?? winner.alias}/><StateRow label="Delegation" value={participant ? participant.winner ? "Consumed at settlement" : "Reclaimed" : "Account-bound"} good={Boolean(participant)}/><StateRow label="Result" value={participant ? participant.winner ? "Won" : "Lost" : "Connect to resolve"} good={Boolean(participant)}/><StateRow label="Other bid values" value="Not visible" hidden/></div><WalletPanel wallet={wallet} connectWallet={connectWallet} disconnectWallet={disconnectWallet} roleMessage={roleMessage}/></>;
}

type WalletPanelProps = {
  wallet: WalletState;
  connectWallet: () => void;
  disconnectWallet: () => void;
};

function WalletPanel({ wallet, connectWallet, disconnectWallet, roleMessage }: WalletPanelProps & { roleMessage: string }) {
  const connected = wallet.status === "connected";
  return <div className={`wallet-panel ${wallet.status}`}><div className="wallet-panel-head"><span><Wallet size={14}/> FREIGHTER · TESTNET</span>{connected ? <button type="button" onClick={disconnectWallet}>Disconnect</button> : <button type="button" onClick={connectWallet} disabled={wallet.status === "connecting"}>{wallet.status === "connecting" ? "Connecting..." : "Connect wallet"}</button>}</div>{connected && <div className="wallet-account"><strong>{compact(wallet.session.address, 10, 8)}</strong><span>{wallet.session.network} · round {wallet.roundStatus}</span></div>}<p className={wallet.status === "error" ? "wallet-error" : ""}>{wallet.status === "error" ? wallet.message : roleMessage}</p>{connected && wallet.roundStatus === "Settled" && <div className="wallet-final"><Check size={14}/><span>Archived round is read-only. No transaction is required.</span></div>}</div>;
}

function AuditorRole() {
  return <><div className="panel-label"><ShieldCheck size={15} /> AUTHORIZED AUDITOR VIEW</div><div className="auditor-lock verified"><div className="lock-visual"><KeyRound size={24}/></div><div><strong>Signed audit export verified</strong><span>Decrypted values remain in the local auditor vault.</span></div></div><div className="state-stack compact"><StateRow label="Auditor key version" value={String(testnetEvidence.audit.auditor.keyVersion)}/><StateRow label="Linked ciphertext events" value={String(testnetEvidence.audit.eventVerification.indexedEvents)} good/><StateRow label="Settlement channels" value="Agree" good/><StateRow label="Recipient disclosure" value="Verified" good/><StateRow label="Disclosure proof" value={`${testnetEvidence.disclosure.proof.bytes.toLocaleString()} B`}/><StateRow label="Export fingerprint" value={compact(testnetEvidence.audit.exportIntegrity.privateExportSha256, 8, 6)}/><StateRow label="Decrypted values" value="Restricted" hidden/></div></>;
}

function StateRow({ label, value, good, hidden }: { label: string; value: string; good?: boolean; hidden?: boolean }) {
  return <div className="state-row"><span>{label}</span><strong className={good ? "good" : hidden ? "hidden" : ""}>{good && <Check size={14}/>} {hidden && <EyeOff size={14}/>} {value}</strong></div>;
}

function LiveCheckPanel({ state }: { state: LiveState }) {
  if (state.status === "checking") {
    return <section className="live-check-panel pending"><Activity size={17}/><span>Reading live contract state...</span></section>;
  }
  if (state.status === "fallback") {
    return <section className="live-check-panel fallback"><Clock3 size={17}/><span>Live RPC unavailable. Recorded Testnet evidence remains active.</span></section>;
  }
  return (
    <section className={`live-check-panel ${state.status}`} aria-label="Live Testnet checks">
      {state.snapshot.checks.map((check) => (
        <div className={check.matched ? "matched" : "failed"} key={check.label}>
          {check.matched ? <Check size={14}/> : <X size={14}/>}
          <span>{check.label}</span>
        </div>
      ))}
    </section>
  );
}

function EvidencePage({ onEvidence, live }: { onEvidence: () => void; live: LiveState }) {
  const checks = [
    ["Account-bound registration", testnetEvidence.deployment.verificationKeys.register.transactionHash, "Verified"],
    ["Controller contract authorization", testnetEvidence.controller.controllerRegistrationTransaction, "Verified"],
    ["Unauthorized participation", testnetEvidence.setup.rejectedAccount, "Rejected"],
    ["Max-Bid statement match", testnetEvidence.settlement.maxBidProof.sha256, "448 bytes"],
    ["Atomic settlement", testnetEvidence.settlement.finalizeTransaction, "Settled"],
    ["Auditor event linkage", testnetEvidence.settlement.finalizeTransaction, "Verified"],
    ["Signed audit export", testnetEvidence.audit.auditor.registrationTransaction, "Signed"],
    ["Recipient-bound disclosure", testnetEvidence.disclosure.event.transaction, "Verified"],
    ["Atomic bid withdrawal", testnetEvidence.withdrawal.transactions.withdrawBid, "Reclaimed"],
    ...testnetEvidence.reclaim.losingBidderReclaims.map((item, index) => [
      `Losing-bid reclaim ${index + 1}`,
      item.transaction,
      "Reclaimed",
    ]),
  ];
  return (
    <main className="page-shell">
      <section className="page-title"><div><span className="role-banner">REVIEWER EVIDENCE</span><h1>Verification index</h1><p>Claims mapped to the completed Testnet run.</p></div><button className="primary-button" type="button" onClick={onEvidence}><PanelRightOpen size={17}/> Open receipt</button></section>
      <LiveCheckPanel state={live}/>
      <section className="evidence-ledger-band"><div><span>Ledger range</span><strong>{testnetEvidence.deployment.ledgerRange.start.toLocaleString()}–{testnetEvidence.deployment.ledgerRange.end.toLocaleString()}</strong></div><div><span>Final proof hash</span><strong>{compact(testnetEvidence.settlement.maxBidProof.sha256, 12, 10)}</strong></div><div><span>Network</span><strong>Stellar Testnet</strong></div></section>
      <section className="data-section evidence-table-section"><div className="section-heading"><div><div className="section-kicker">APPEND-ONLY RECORD</div><h2>Claim verification</h2></div><BadgeCheck size={22} className="green-icon"/></div><div className="check-list">{checks.map(([label, reference, result], index) => <a href={index === 2 ? undefined : explorerTransaction(reference)} target="_blank" rel="noreferrer" className="check-row" key={label}><span className={`check-icon ${index === 2 ? "denied" : ""}`}>{index === 2 ? <Ban size={16}/> : <Check size={16}/>}</span><div><strong>{label}</strong><span>{compact(reference, 10, 8)}</span></div><b>{result}</b>{index !== 2 && <ArrowUpRight size={15}/>}</a>)}</div></section>
      <ProofFingerprint />
    </main>
  );
}

function ProofFingerprint() {
  const bytes = useMemo(() => testnetEvidence.settlement.maxBidProof.sha256.match(/.{2}/g)!.map((value) => Number.parseInt(value, 16)), []);
  return <section className="fingerprint-section"><div><div className="section-kicker">MAX-BID PROOF FINGERPRINT</div><h2>14,592-byte proof</h2><p>{testnetEvidence.settlement.maxBidProof.publicInputBytes} public-input bytes · market statement matched</p></div><div className="fingerprint-bars" aria-label="Visual fingerprint of Max-Bid proof hash">{bytes.map((value, index) => <span key={index} style={{height: `${18 + (value / 255) * 74}%`}} />)}</div></section>;
}

function ContractsPage() {
  return (
    <main className="page-shell">
      <section className="page-title"><div><span className="role-banner">PINNED TESTNET STACK</span><h1>Contract registry</h1><p>Deployed from the revisions recorded in the evidence manifest.</p></div><div className="network-state large"><span className="network-dot"/>{contracts.length} active contracts</div></section>
      <section className="contract-grid">{contracts.map(([name, item]) => <a className="contract-row" href={explorerContract(item.contractId)} target="_blank" rel="noreferrer" key={name}><div className="contract-icon"><Database size={18}/></div><div><strong>{name}</strong><span>{item.contractId}</span></div><ArrowUpRight size={17}/></a>)}</section>
      <section className="revision-band"><div><span>OpenZeppelin contracts</span><strong>{compact(testnetEvidence.deployment.revisions.stellarContracts, 12, 8)}</strong></div><div><span>UltraHonk backend</span><strong>{compact(testnetEvidence.deployment.revisions.ultraHonk, 12, 8)}</strong></div><div><span>Noir</span><strong>{testnetEvidence.deployment.revisions.noir}</strong></div><div><span>Barretenberg</span><strong>{testnetEvidence.deployment.revisions.barretenberg}</strong></div></section>
    </main>
  );
}

function EvidenceDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open && canvas.current) QRCode.toCanvas(canvas.current, testnetEvidence.settlement.explorer, { width: 136, margin: 1, color: { dark: "#10231c", light: "#ffffff" } });
  }, [open]);
  const copyHash = async () => {
    await navigator.clipboard.writeText(testnetEvidence.settlement.finalizeTransaction);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return <><button className={`drawer-scrim ${open ? "open" : ""}`} aria-label="Close evidence drawer" onClick={onClose}/><aside className={`evidence-drawer ${open ? "open" : ""}`} aria-hidden={!open}><div className="drawer-header"><div><span className="section-kicker">FINAL RECEIPT</span><h2>Atomic settlement</h2></div><IconButton label="Close evidence drawer" onClick={onClose}><X size={19}/></IconButton></div><div className="receipt-status"><div className="receipt-check"><Check size={21}/></div><div><strong>Confirmed on Testnet</strong><span>Payment and RWA delivery completed</span></div></div><div className="receipt-block"><span>Transaction hash</span><div className="copy-field"><code>{testnetEvidence.settlement.finalizeTransaction}</code><IconButton label="Copy transaction hash" onClick={copyHash}>{copied ? <Check size={17}/> : <Copy size={17}/>}</IconButton></div></div><div className="receipt-grid"><div><span>Round</span><strong>{compact(testnetEvidence.settlement.roundId)}</strong></div><div><span>Winner</span><strong>{compact(testnetEvidence.settlement.winner)}</strong></div><div><span>Max-Bid proof</span><strong>{testnetEvidence.settlement.maxBidProof.bytes.toLocaleString()} B</strong></div><div><span>Statement</span><strong>{testnetEvidence.settlement.maxBidProof.publicInputBytes} B match</strong></div></div><div className="qr-block"><canvas ref={canvas}/><div><strong>Explorer receipt</strong><span>Stellar Expert · Testnet</span><a href={testnetEvidence.settlement.explorer} target="_blank" rel="noreferrer">Open transaction <ArrowUpRight size={14}/></a></div></div><div className="limitations"><ShieldCheck size={17}/><p>Unaudited Testnet-only prototype. No production or mainnet value.</p></div></aside></>;
}

export function App() {
  const [page, setPage] = useState<Page>("round");
  const [role, setRole] = useState<Role>("public");
  const [stage, setStage] = useState<number>(demoSteps.length);
  const [running, setRunning] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [live, setLive] = useState<LiveState>({ status: "checking" });
  const [wallet, setWallet] = useState<WalletState>({ status: "disconnected" });

  const refreshLive = useCallback(() => {
    setLive({ status: "checking" });
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("Testnet verification timed out")), 10_000);
    });
    const verification = import("./live").then(({ verifyLiveTestnet }) => verifyLiveTestnet());
    void Promise.race([verification, timeout])
      .then((snapshot) => setLive({ status: snapshot.allMatched ? "verified" : "mismatch", snapshot }))
      .catch((error: unknown) => setLive({
        status: "fallback",
        error: error instanceof Error ? error.message : "Testnet verification failed",
      }));
  }, []);

  useEffect(() => refreshLive(), [refreshLive]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setStage((current) => {
        if (current >= demoSteps.length - 1) {
          setRunning(false);
          return demoSteps.length;
        }
        return current + 1;
      });
    }, 780);
    return () => window.clearInterval(timer);
  }, [running]);

  const runReplay = () => { setStage(0); setRunning(true); };

  const connectWallet = useCallback(() => {
    setWallet({ status: "connecting" });
    void import("./wallet")
      .then(async ({ connectFreighter, productClient }) => {
        const session = await connectFreighter();
        const round = await productClient().round(testnetEvidence.settlement.roundId);
        const nativeStatus = round.status;
        const roundStatus = Array.isArray(nativeStatus) ? String(nativeStatus[0]) : String(nativeStatus);
        setWallet({ status: "connected", session, roundStatus });
      })
      .catch((error: unknown) => setWallet({
        status: "error",
        message: error instanceof Error ? error.message : "Could not connect Freighter",
      }));
  }, []);

  return (
    <div className="app-frame">
      <AppHeader page={page} setPage={setPage}/>
      <LiveVerificationBar state={live} refresh={refreshLive}/>
      {page === "round" && <main className="page-shell"><RoundHeader onEvidence={() => setDrawer(true)}/><Metrics/><JudgeReplay stage={stage} running={running} onRun={runReplay} onStop={() => setRunning(false)}/><div className="main-grid"><ParticipantsTable/><RolePanel role={role} setRole={setRole} wallet={wallet} connectWallet={connectWallet} disconnectWallet={() => setWallet({ status: "disconnected" })}/></div></main>}
      {page === "evidence" && <EvidencePage onEvidence={() => setDrawer(true)} live={live}/>}
      {page === "contracts" && <ContractsPage/>}
      <EvidenceDrawer open={drawer} onClose={() => setDrawer(false)}/>
      <footer><span>QuietBook · Stellar Testnet · Unaudited prototype</span><a href={testnetEvidence.settlement.explorer} target="_blank" rel="noreferrer"><Link2 size={14}/> Evidence receipt</a></footer>
    </div>
  );
}
