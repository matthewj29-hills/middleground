export type Speaker = 1 | 2 | 3;

export interface Turn {
  id: string;
  speaker: Speaker | 'min';
  text: string;
  ts: number;            // epoch ms of first utterance in turn
  sources?: SourceRef[]; // for Min turns
  kind?: 'answer' | 'correction' | 'ack';
}

export interface SourceRef {
  title: string;
  url: string;
}

export interface FactNotice {
  id: string;
  claim: string;
  note: string;
  sources: SourceRef[];
  spoken: boolean;
  ts: number;
}

export type MinState =
  | 'idle'
  | 'acknowledged'
  | 'capturing'
  | 'processing'
  | 'speaking';

export type ListenState =
  | 'off'
  | 'listening'
  | 'suppressed'   // paused while Min speaks
  | 'error';

export interface SessionData {
  id: string;
  startedAt: number;
  endedAt: number | null;
  turns: Turn[];
  notices: FactNotice[];
  contextSummary: string; // compressed older context
  report: Report | null;
}

export interface ReportSection {
  title: string;
  items: string[];
}

export interface Report {
  summary: string;
  viewpoints: string[];
  agreements: string[];
  verifiedFacts: { fact: string; source?: string }[];
  disputed: string[];
  misunderstandings: string[];
  coreDisagreement: string;
  commonGround: string;
  takeaways: string[];
  degraded?: string; // honest note when generated without LLM
}

export interface ClaimVerdict {
  claim: string;
  verdict: 'false' | 'misleading' | 'true' | 'unverified';
  confidence: number;
  correction: string;
  sources: SourceRef[];
}
