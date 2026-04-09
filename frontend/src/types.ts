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
