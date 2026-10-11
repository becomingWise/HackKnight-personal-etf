export type LabEvent = {
  id: string;
  provider: string;
  topicId?: string;
  status: string;
  linkedSymbols: string[];
  [key: string]: unknown;
};
export type LabSnapshot = {
  schemaVersion: number;
  builtAt: string | null;
  note?: string;
  stocks: Record<string, { prices: { date: string; close: number }[] } | undefined>;
  events: LabEvent[];
};
export const snapshot: LabSnapshot;
