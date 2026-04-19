export interface MapHeader {
  label: string;
  sortKey: string;
}

export interface LeaderboardRow {
  rank: number;
  name: string;
  countryISO2: string;
  mapTimes: string[];
  mapTimesMs: number[];
  mapRanks: number[];
  totalTime: string;
  totalMs: number;
  diffToFirst: string;
  medalClass: string;
  lastImprovedUnix: number;
}

export interface LeaderboardData {
  players: LeaderboardRow[];
  mapHeaders: MapHeader[];
  sortBy: string;
  sortDir: string;
  page: number;
  totalPages: number;
  updatedAtUnix: number;
  totalPlayers: number;
}

export interface SearchResult {
  rank: number;
  name: string;
  countryISO2: string;
  page: number;
}

export interface Stage2PlayerEntry {
  displayPosition: number;
  name: string;
  trackmaniaId: string;
  countryISO2: string;
  sourceRank: number;
  sourceName: string;
  isPlaceholder: boolean;
  rank: number | null;
  score: number | null;
  inCompetition: boolean;
}

export interface Stage2MatchData {
  id: string;
  name: string;
  scheduledTimeUnix: number;
  completionTimeUnix: number | null;
  players: Stage2PlayerEntry[];
}

export interface Stage2RoundData {
  matches: Stage2MatchData[];
}

export interface Stage2Data {
  rounds: Stage2RoundData[];
  updatedAtUnix: number;
}
