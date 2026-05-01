import { useState, useEffect, useCallback, useRef } from "react";
import "./App.css";
import type {
  LeaderboardData,
  SearchResult,
  Stage2Data,
  Stage2PlayerEntry,
} from "./types";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(iso2: string): string {
  try {
    return regionNames.of(iso2.toUpperCase()) ?? iso2.toUpperCase();
  } catch {
    return iso2.toUpperCase();
  }
}

function formatRelativeTime(unixSeconds: number): string {
  if (unixSeconds === 0) return "";
  const d = Date.now() / 1000 - unixSeconds;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function formatElapsed(unixSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  let str = "";
  if (h > 0) str += h + "h";
  if (m > 0 || h > 0) str += m + "m";
  str += s + "s";
  return str;
}

function parseRoundNum(matchName: string): number {
  if (/dutch/i.test(matchName)) return 5;
  const m = matchName.match(/Round\s+(\d+)/i);
  return m ? parseInt(m[1]) : 0;
}

function roundSectionTitle(roundNum: number): string {
  switch (roundNum) {
    case 1:
      return "Round 1";
    case 2:
      return "Round 2 \u2014 Second Chance";
    case 3:
      return "Round 3 \u2014 Survival";
    case 4:
      return "Round 4 \u2014 Final Chance";
    case 5:
      return "Round 5 \u2014 Dutch Qualifier (Optional)";
    default:
      return `Round ${roundNum}`;
  }
}

function formatScheduledTime(unixSeconds: number): string {
  if (unixSeconds === 0) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

const progressionAccentColor: Record<string, string> = {
  "prog-finals": "#28c864",
  "prog-advance": "#3c8ce6",
  "prog-eliminated": "#b4283c",
  "prog-conditional": "#e6be28",
  "prog-dutch-maybe": "#e6be28",
  "prog-dutch-confirmed": "#28c896",
};

function App() {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [stage2Data, setStage2Data] = useState<Stage2Data | null>(null);
  const [stage, setStage] = useState(1);
  const stageRef = useRef(1);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("rank");
  const [sortDir, setSortDir] = useState("asc");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [stage2SearchQuery, setStage2SearchQuery] = useState("");
  const [stage2SearchResults, setStage2SearchResults] = useState<
    { name: string; countryISO2: string }[]
  >([]);
  const [stage2ShowDropdown, setStage2ShowDropdown] = useState(false);
  const [elapsed, setElapsed] = useState("");
  const [collapsedRounds, setCollapsedRounds] = useState<Set<number>>(
    new Set(),
  );
  const [tooltip, setTooltip] = useState<{
    text: string;
    x: number;
    y: number;
    accent: string;
    pinned: boolean;
  } | null>(null);

  // Auto-collapse rounds: expand only the active/next/last-completed rounds
  useEffect(() => {
    if (!stage2Data) return;
    const nowUnix = Date.now() / 1000;
    const allMatches = (stage2Data.rounds ?? []).flatMap(
      (r) => r.matches ?? [],
    );
    const roundMap = new Map<number, typeof allMatches>();
    for (const match of allMatches) {
      const rn = parseRoundNum(match.name);
      if (!roundMap.has(rn)) roundMap.set(rn, []);
      roundMap.get(rn)!.push(match);
    }
    const sortedNums = Array.from(roundMap.keys()).sort((a, b) => a - b);

    let activeRound: number | null = null;
    let nextRound: number | null = null;
    let lastCompletedRound: number | null = null;
    for (const rn of sortedNums) {
      const matches = roundMap.get(rn)!;
      const hasActive = matches.some(
        (m) =>
          m.scheduledTimeUnix > 0 &&
          m.scheduledTimeUnix <= nowUnix &&
          m.completionTimeUnix === null,
      );
      const allComplete = matches.every((m) => m.completionTimeUnix !== null);
      const hasUpcoming = matches.some((m) => m.scheduledTimeUnix > nowUnix);
      if (hasActive && activeRound === null) activeRound = rn;
      if (allComplete) lastCompletedRound = rn;
      if (hasUpcoming && nextRound === null) nextRound = rn;
    }

    const expand = new Set<number>();
    if (activeRound !== null) {
      expand.add(activeRound);
    } else {
      if (lastCompletedRound !== null) expand.add(lastCompletedRound);
      if (nextRound !== null) expand.add(nextRound);
      if (expand.size === 0) sortedNums.forEach((rn) => expand.add(rn));
    }
    setCollapsedRounds(new Set(sortedNums.filter((rn) => !expand.has(rn))));
  }, [stage2Data]);
  const debounceRef = useRef(0);
  const highlightRef = useRef<HTMLTableRowElement>(null);
  const initializedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectDelay = useRef(1000);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pinnedRowRef = useRef<HTMLTableRowElement | null>(null);

  // Read initial URL params (once)
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const p = parseInt(params.get("page") || "1");
    const s = params.get("sort") || "rank";
    const d = params.get("dir") || (s === "improved" ? "desc" : "asc");
    const h = params.get("highlight");
    if (p > 0) setPage(p);
    setSortBy(s);
    setSortDir(d);
    if (h) setHighlight(h);

    // Stage: read from URL or default based on date
    const stageParam = params.get("stage");
    let defaultStage = 1;
    if (new Date() >= new Date("2026-05-01")) {
      defaultStage = 2;
    }
    const initialStage = stageParam ? parseInt(stageParam) : defaultStage;
    if (initialStage === 2) {
      setStage(2);
      stageRef.current = 2;
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const resp = await fetch(
        `/api/leaderboard?page=${page}&sort=${sortBy}&dir=${sortDir}`,
      );
      const json: LeaderboardData = await resp.json();
      setData(json);
    } catch (err) {
      console.error("Failed to fetch leaderboard:", err);
    }
  }, [page, sortBy, sortDir]);

  const fetchStage2Data = useCallback(async () => {
    try {
      const resp = await fetch("/api/stage2");
      if (!resp.ok) return;
      const json: Stage2Data = await resp.json();
      setStage2Data(json);
    } catch (err) {
      console.error("Failed to fetch stage 2 data:", err);
    }
  }, []);

  // Keep fetchDataRef always current so the static WS handler calls the latest version
  const fetchDataRef = useRef(fetchData);
  const fetchStage2Ref = useRef(fetchStage2Data);
  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);
  useEffect(() => {
    fetchStage2Ref.current = fetchStage2Data;
  }, [fetchStage2Data]);

  // Fetch data on mount and when params change
  useEffect(() => {
    if (stage === 1) fetchData();
  }, [fetchData, stage]);

  useEffect(() => {
    if (stage === 2) fetchStage2Data();
  }, [fetchStage2Data, stage]);

  // WebSocket connection for server-push refresh
  useEffect(() => {
    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        wsReconnectDelay.current = 1000;
      };

      ws.onmessage = (event) => {
        if (event.data === "refresh") {
          if (stageRef.current === 1) {
            fetchDataRef.current();
          } else if (stageRef.current === 2) {
            fetchStage2Ref.current();
          }
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        const delay = wsReconnectDelay.current;
        wsReconnectDelay.current = Math.min(delay * 2, 30000);
        wsReconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      if (wsReconnectTimer.current !== null) {
        clearTimeout(wsReconnectTimer.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update URL when state changes
  useEffect(() => {
    stageRef.current = stage;
    const params = new URLSearchParams();
    if (stage !== 1) params.set("stage", String(stage));
    if (page > 1) params.set("page", String(page));
    if (sortBy !== "rank" || sortDir !== "asc") {
      params.set("sort", sortBy);
      params.set("dir", sortDir);
    }
    if (highlight) params.set("highlight", highlight);
    const qs = params.toString();
    const url = qs ? `/?${qs}` : "/";
    window.history.replaceState(null, "", url);
  }, [stage, page, sortBy, sortDir, highlight]);

  // Update elapsed timer every second
  useEffect(() => {
    if (!data) return;
    const update = () => setElapsed(formatElapsed(data.updatedAtUnix));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [data]);

  // Scroll to highlighted row
  useEffect(() => {
    if (highlight && highlightRef.current) {
      highlightRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [highlight, data, stage2Data]);

  // Auto-expand rounds containing the highlighted player (stage 2)
  useEffect(() => {
    if (stage !== 2 || !highlight || !stage2Data) return;
    const allMatches = (stage2Data.rounds ?? []).flatMap(
      (r) => r.matches ?? [],
    );
    const roundsToExpand = new Set<number>();
    for (const match of allMatches) {
      const roundNum = parseRoundNum(match.name);
      if ((match.players ?? []).some((p) => p.name === highlight)) {
        roundsToExpand.add(roundNum);
      }
    }
    if (roundsToExpand.size > 0) {
      setCollapsedRounds((prev) => {
        const next = new Set(prev);
        roundsToExpand.forEach((rn) => next.delete(rn));
        return next;
      });
    }
  }, [highlight, stage, stage2Data]);

  // Close search dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".search-wrap")) {
        setShowDropdown(false);
        setStage2ShowDropdown(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // Dismiss pinned tooltip on outside click/touch
  useEffect(() => {
    if (!tooltip?.pinned) return;
    const dismiss = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Element;
      if (pinnedRowRef.current && pinnedRowRef.current.contains(target)) return;
      if (tooltipRef.current && tooltipRef.current.contains(target)) return;
      pinnedRowRef.current = null;
      setTooltip(null);
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", dismiss);
      document.addEventListener("touchstart", dismiss as EventListener);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("touchstart", dismiss as EventListener);
    };
  }, [tooltip?.pinned]);

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir(key === "improved" ? "desc" : "asc");
    }
    setPage(1);
  };

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (q.trim().length < 2) {
      setShowDropdown(false);
      setSearchResults([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const resp = await fetch(
          `/api/search?q=${encodeURIComponent(q.trim())}`,
        );
        const results: SearchResult[] = await resp.json();
        setSearchResults(results || []);
        setShowDropdown(true);
      } catch (err) {
        console.error("Search failed:", err);
      }
    }, 250);
  };

  const handleSearchResultClick = (result: SearchResult) => {
    setPage(result.page);
    setSortBy("rank");
    setSortDir("asc");
    setHighlight(result.name);
    setShowDropdown(false);
    setSearchQuery("");
  };

  const handleStage2Search = (q: string) => {
    setStage2SearchQuery(q);
    if (q.trim().length < 2) {
      setStage2ShowDropdown(false);
      setStage2SearchResults([]);
      return;
    }
    if (!stage2Data) return;
    const query = q.trim().toLowerCase();
    const seen = new Set<string>();
    const results: { name: string; countryISO2: string }[] = [];
    for (const round of stage2Data.rounds ?? []) {
      for (const match of round.matches ?? []) {
        for (const player of match.players ?? []) {
          if (
            !player.isPlaceholder &&
            !seen.has(player.name) &&
            player.name.toLowerCase().includes(query)
          ) {
            seen.add(player.name);
            results.push({
              name: player.name,
              countryISO2: player.countryISO2,
            });
          }
        }
      }
    }
    setStage2SearchResults(results.slice(0, 20));
    setStage2ShowDropdown(true);
  };

  const handleStage2SearchResultClick = (name: string) => {
    setHighlight(name);
    setStage2SearchQuery("");
    setStage2ShowDropdown(false);
  };

  const handleStageChange = (newStage: number) => {
    setStage(newStage);
    stageRef.current = newStage;
    setPage(1);
  };

  const getSortClass = (key: string): string => {
    if (sortBy !== key) return "sortable";
    return `sortable ${sortDir === "asc" ? "sort-asc" : "sort-desc"}`;
  };

  if (stage === 1 && !data) {
    return <div className="container loading">Loading leaderboard...</div>;
  }

  const IconFirst = () => (
    <svg
      width="14"
      height="14"
      viewBox="3 1 18 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path d="M19,21 L9.5,12 L19,3 M5,3 L5,21" />
    </svg>
  );
  const IconPrev = () => (
    <svg
      width="14"
      height="14"
      viewBox="5 1 14 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <polyline points="17.0011615 3 7 12.0021033 17.0011615 21.0042067" />
    </svg>
  );
  const IconNext = () => (
    <svg
      width="14"
      height="14"
      viewBox="5 1 14 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <polyline points="7 3 17.0011615 12.0021033 7 21.0042067" />
    </svg>
  );
  const IconLast = () => (
    <svg
      width="14"
      height="14"
      viewBox="3 1 18 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      <path
        d="M19,21 L9.5,12 L19,3 M5,3 L5,21"
        transform="translate(11.750000, 12.000000) scale(-1, 1) translate(-11.750000, -12.000000)"
      />
    </svg>
  );

  const toggleRound = (ri: number) => {
    setCollapsedRounds((prev) => {
      const next = new Set(prev);
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
  };

  const renderStage2 = () => {
    if (!stage2Data) {
      return <div className="stage2-loading">Loading Stage 2 data...</div>;
    }

    const nowUnix = Date.now() / 1000;
    let firstHighlightSeen = false;

    // Flatten all matches and group by round number parsed from match name
    const allMatches = (stage2Data.rounds ?? []).flatMap(
      (r) => r.matches ?? [],
    );
    const roundMap = new Map<number, typeof allMatches>();
    for (const match of allMatches) {
      const roundNum = parseRoundNum(match.name);
      if (!roundMap.has(roundNum)) roundMap.set(roundNum, []);
      roundMap.get(roundNum)!.push(match);
    }
    const sortedRounds = Array.from(roundMap.entries()).sort(
      ([a], [b]) => a - b,
    );

    // Stage 3 qualification & Dutch Qualifier logic
    const dutchAlreadyQualified = allMatches
      .filter((m) => m.completionTimeUnix !== null)
      .flatMap((m) => m.players ?? [])
      .some(
        (p) =>
          p.progressionType === "finals" &&
          !p.isPlaceholder &&
          p.countryISO2.toUpperCase() === "NL",
      );
    const round4Matches = roundMap.get(4) ?? [];
    const round4HasFinished = round4Matches.some(
      (m) => m.completionTimeUnix !== null,
    );
    // Build qualifier list — show as soon as any match produces a qualifier.
    // Round 5 (Dutch Qualifier) is excluded from the main loop and handled separately.
    const finalQualifiers: Array<{
      player: Stage2PlayerEntry;
      matchName: string;
    }> = [];
    for (const [roundNum, roundMatches] of sortedRounds) {
      if (roundNum === 5) continue;
      for (const match of roundMatches) {
        if (match.completionTimeUnix === null) continue;
        for (const player of match.players ?? []) {
          if (player.progressionType === "finals" && !player.isPlaceholder) {
            finalQualifiers.push({ player, matchName: match.name });
          }
        }
      }
    }
    // Add the conditional 8th slot once we know which path was taken
    if (dutchAlreadyQualified) {
      // Dutch player already in Stage 3 — R4 P2 gets the direct spot
      for (const match of round4Matches) {
        if (match.completionTimeUnix === null) continue;
        const p = (match.players ?? []).find(
          (p) => p.progressionType === "conditional" && !p.isPlaceholder,
        );
        if (p) {
          finalQualifiers.push({ player: p, matchName: match.name });
          break;
        }
      }
    } else {
      // Dutch Qualifier winner gets the 8th slot (only once that match finishes)
      for (const match of roundMap.get(5) ?? []) {
        if (match.completionTimeUnix === null) continue;
        const p = (match.players ?? []).find(
          (p) => p.progressionType === "finals" && !p.isPlaceholder,
        );
        if (p) {
          finalQualifiers.push({ player: p, matchName: match.name });
          break;
        }
      }
    }
    const showQualifierPreview = finalQualifiers.length > 0;
    const showFootnote = round4HasFinished && !dutchAlreadyQualified;
    // Hide the Dutch Qualifier round section when it is not needed
    const visibleRounds = dutchAlreadyQualified
      ? sortedRounds.filter(([n]) => n !== 5)
      : sortedRounds;

    return (
      <div className="stage2-rounds">
        {visibleRounds.map(([roundNum, matches]) => {
          const isCollapsed = collapsedRounds.has(roundNum);
          return (
            <div key={roundNum} className="stage2-round-section">
              <button
                className="round-section-header"
                onClick={() => toggleRound(roundNum)}
              >
                <span className="round-section-title">
                  {roundSectionTitle(roundNum)}
                </span>
                <span
                  className={`round-chevron${isCollapsed ? " collapsed" : ""}`}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="2,5 7,10 12,5" />
                  </svg>
                </span>
              </button>
              {!isCollapsed && (
                <div className="stage2-matches-row">
                  {matches.map((match, mi) => {
                    const isFinished = match.completionTimeUnix !== null;
                    const isLive =
                      !isFinished &&
                      match.scheduledTimeUnix > 0 &&
                      nowUnix >= match.scheduledTimeUnix;
                    const statusLabel = isFinished
                      ? "Finished"
                      : isLive
                        ? "Live"
                        : "Upcoming";
                    const statusClass = isFinished
                      ? "finished"
                      : isLive
                        ? "live"
                        : "upcoming";

                    return (
                      <div key={mi} className="stage2-match">
                        <div className="match-header">
                          <div className="match-header-left">
                            <span className="match-name">{match.name}</span>
                            <span
                              className={`match-status-badge ${statusClass}`}
                            >
                              {statusLabel}
                            </span>
                          </div>
                          <div className="match-scheduled">
                            {formatScheduledTime(match.scheduledTimeUnix)}
                          </div>
                        </div>
                        <div className="stage2-table-wrap">
                          <table className="stage2-table">
                            {(() => {
                              const allPlaceholders = (
                                match.players ?? []
                              ).every((p) => p.isPlaceholder);
                              return (
                                <>
                                  <thead>
                                    <tr>
                                      <th className="rank-col">#</th>
                                      <th>Player</th>
                                      {!allPlaceholders && (
                                        <th className="r">Score</th>
                                      )}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(match.players ?? []).map((player, pi) => {
                                      const isHighlighted =
                                        !player.isPlaceholder &&
                                        highlight === player.name;
                                      const isFirstHighlight =
                                        isHighlighted && !firstHighlightSeen;
                                      if (isFirstHighlight)
                                        firstHighlightSeen = true;
                                      const isDutchCandidate =
                                        isFinished &&
                                        !player.isPlaceholder &&
                                        !dutchAlreadyQualified &&
                                        player.progressionType ===
                                          "eliminated" &&
                                        player.countryISO2.toUpperCase() ===
                                          "NL" &&
                                        [1, 3, 4].includes(roundNum);
                                      const progressionClass = (() => {
                                        if (!isFinished)
                                          return player.displayPosition === 1
                                            ? "gold"
                                            : player.displayPosition === 2
                                              ? "silver"
                                              : player.displayPosition === 3
                                                ? "bronze"
                                                : "";
                                        if (isDutchCandidate)
                                          return round4HasFinished
                                            ? "prog-dutch-confirmed"
                                            : "prog-dutch-maybe";
                                        if (
                                          player.progressionType ===
                                          "conditional"
                                        ) {
                                          if (dutchAlreadyQualified)
                                            return "prog-finals";
                                          if (
                                            player.countryISO2.toUpperCase() ===
                                            "NL"
                                          )
                                            return "prog-dutch-confirmed";
                                          return "prog-eliminated";
                                        }
                                        return player.progressionType
                                          ? `prog-${player.progressionType}`
                                          : "";
                                      })();
                                      const progressionTitle = (() => {
                                        if (!isFinished || !player.progression)
                                          return undefined;
                                        if (isDutchCandidate)
                                          return round4HasFinished
                                            ? "Candidate for Dutch Qualifier"
                                            : "May be selected for Dutch Qualifier";
                                        if (
                                          player.progressionType ===
                                          "conditional"
                                        ) {
                                          if (dutchAlreadyQualified)
                                            return "Qualifies for Stage 3 Finals";
                                          if (
                                            player.countryISO2.toUpperCase() ===
                                            "NL"
                                          )
                                            return "Advances to Dutch Qualifier";
                                          return "Eliminated";
                                        }
                                        return player.progression;
                                      })();
                                      return (
                                        <tr
                                          key={pi}
                                          className={[
                                            progressionClass,
                                            isHighlighted ? "highlighted" : "",
                                          ]
                                            .filter(Boolean)
                                            .join(" ")}
                                          style={{
                                            cursor: progressionTitle
                                              ? "pointer"
                                              : undefined,
                                          }}
                                          ref={
                                            isFirstHighlight
                                              ? highlightRef
                                              : undefined
                                          }
                                          onMouseEnter={(e) => {
                                            if (
                                              pinnedRowRef.current ||
                                              !progressionTitle
                                            )
                                              return;
                                            const rect =
                                              e.currentTarget.getBoundingClientRect();
                                            setTooltip({
                                              text: progressionTitle,
                                              x: rect.left + rect.width / 2,
                                              y: rect.top - 6,
                                              accent:
                                                progressionAccentColor[
                                                  progressionClass
                                                ] ?? "#1e3a58",
                                              pinned: false,
                                            });
                                          }}
                                          onMouseLeave={() => {
                                            if (!pinnedRowRef.current)
                                              setTooltip(null);
                                          }}
                                          onClick={(e) => {
                                            if (!progressionTitle) return;
                                            const el = e.currentTarget;
                                            if (pinnedRowRef.current === el) {
                                              pinnedRowRef.current = null;
                                              setTooltip(null);
                                            } else {
                                              pinnedRowRef.current = el;
                                              const rect =
                                                el.getBoundingClientRect();
                                              setTooltip({
                                                text: progressionTitle,
                                                x: rect.left + rect.width / 2,
                                                y: rect.top - 6,
                                                accent:
                                                  progressionAccentColor[
                                                    progressionClass
                                                  ] ?? "#1e3a58",
                                                pinned: true,
                                              });
                                            }
                                          }}
                                        >
                                          <td className="rank-col">
                                            {player.displayPosition}
                                          </td>
                                          <td className="player-col">
                                            {player.isPlaceholder ? (
                                              <span className="placeholder-player">
                                                #{player.sourceRank} from{" "}
                                                {player.sourceName}
                                              </span>
                                            ) : (
                                              <div className="player-inner">
                                                {player.countryISO2 && (
                                                  <img
                                                    src={`https://flagcdn.com/20x15/${player.countryISO2.toLowerCase()}.png`}
                                                    alt={player.countryISO2}
                                                    title={countryName(
                                                      player.countryISO2,
                                                    )}
                                                    onError={(e) => {
                                                      e.currentTarget.style.display =
                                                        "none";
                                                    }}
                                                  />
                                                )}
                                                <span className="player-name">
                                                  {player.name}
                                                </span>
                                                <span
                                                  className={`source-rank${player.sourceRank === 1 ? " source-rank-gold" : player.sourceRank === 2 ? " source-rank-silver" : player.sourceRank === 3 ? " source-rank-bronze" : ""}`}
                                                >
                                                  ({player.sourceRank})
                                                </span>
                                              </div>
                                            )}
                                          </td>
                                          {!allPlaceholders && (
                                            <td className="r">
                                              {player.score !== null
                                                ? player.score
                                                : "-"}
                                            </td>
                                          )}
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </>
                              );
                            })()}
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {showFootnote && (
          <div className="stage2-footnote">
            Round 4 runner-up qualifies for Stage 3 Finals only if a Dutch
            player already secured a Finals spot in a previous round. Otherwise,
            they may or may not advance to the Dutch Qualifier depending on
            whether they are Dutch.
          </div>
        )}
        {showQualifierPreview && (
          <div className="stage2-qualifier-preview">
            <div className="qualifier-preview-title">
              Stage 3 Qualifiers Preview{" "}
              <span className="qualifier-unofficial">(Unofficial)</span>
            </div>
            <table className="qualifier-preview-table">
              <tbody>
                {finalQualifiers.map(({ player, matchName }, i) => (
                  <tr key={i}>
                    <td className="qp-num">{i + 1}</td>
                    <td className="qp-player">
                      <div className="player-inner">
                        {player.countryISO2 && (
                          <img
                            src={`https://flagcdn.com/20x15/${player.countryISO2.toLowerCase()}.png`}
                            alt={player.countryISO2}
                            title={countryName(player.countryISO2)}
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                        <span className="player-name">{player.name}</span>
                      </div>
                    </td>
                    <td className="qp-source">{matchName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderPagination = () => {
    if (!data || data.totalPages <= 1) return null;
    const windowStart = Math.max(1, data.page - 3);
    const windowEnd = Math.min(data.totalPages, data.page + 3);
    const pages: number[] = [];
    for (let i = windowStart; i <= windowEnd; i++) {
      pages.push(i);
    }

    return (
      <nav className="pagination">
        {data.page > 1 ? (
          <>
            <a onClick={() => setPage(1)}>
              <IconFirst />
            </a>
            <a onClick={() => setPage(data.page - 1)}>
              <IconPrev />
            </a>
          </>
        ) : (
          <>
            <span className="disabled">
              <IconFirst />
            </span>
            <span className="disabled">
              <IconPrev />
            </span>
          </>
        )}
        {pages.map((p) =>
          p === data.page ? (
            <span key={p} className="active">
              {p}
            </span>
          ) : (
            <a key={p} onClick={() => setPage(p)}>
              {p}
            </a>
          ),
        )}
        {data.page < data.totalPages ? (
          <>
            <a onClick={() => setPage(data.page + 1)}>
              <IconNext />
            </a>
            <a onClick={() => setPage(data.totalPages)}>
              <IconLast />
            </a>
          </>
        ) : (
          <>
            <span className="disabled">
              <IconNext />
            </span>
            <span className="disabled">
              <IconLast />
            </span>
          </>
        )}
      </nav>
    );
  };

  return (
    <div className="container">
      <header>
        <div className="header-stripe"></div>
        <div className="header-title-row">
          <div className="header-wing"></div>
          <h1>
            <span className="accent">Red Bull</span> Faster
          </h1>
          <div className="header-wing right"></div>
        </div>
        <div className="header-sub">Leaderboard</div>
        <div className="stage-tabs">
          <button
            className={stage === 1 ? "active" : ""}
            onClick={() => handleStageChange(1)}
          >
            Stage 1
          </button>
          <button
            className={stage === 2 ? "active" : ""}
            onClick={() => handleStageChange(2)}
          >
            Stage 2
          </button>
          <button className="stage-tab-disabled" disabled>
            Stage 3
          </button>
        </div>
        {stage === 1 && data && (
          <>
            <div className="meta">
              <span>{data.totalPlayers}</span> players &middot; Updated{" "}
              <span>{elapsed}</span> ago &middot; Page <span>{data.page}</span>{" "}
              of <span>{data.totalPages}</span>
            </div>
            <div className="search-row">
              <div className="search-wrap">
                <span className="search-icon">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="15"
                    height="15"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
                <input
                  type="text"
                  placeholder="Search players..."
                  autoComplete="off"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                />
                {showDropdown && (
                  <div className="search-dropdown">
                    {searchResults.length === 0 ? (
                      <div className="no-results">No players found</div>
                    ) : (
                      searchResults.map((r, i) => (
                        <a key={i} onClick={() => handleSearchResultClick(r)}>
                          <img
                            src={`https://flagcdn.com/20x15/${r.countryISO2}.png`}
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                            alt=""
                            title={countryName(r.countryISO2)}
                          />
                          <span className="sr-name">{r.name}</span>
                          <span className="sr-rank">#{r.rank}</span>
                        </a>
                      ))
                    )}
                  </div>
                )}
              </div>
              {highlight && (
                <button
                  className="clear-highlight"
                  onClick={() => setHighlight(null)}
                >
                  Clear highlight
                </button>
              )}
            </div>
          </>
        )}
      </header>

      <div className="divider"></div>

      {stage === 1 && (
        <>
          {renderPagination()}
          <div className="table-wrap">
            <table id="leaderboard">
              <thead>
                <tr>
                  <th
                    className={getSortClass("rank")}
                    onClick={() => handleSort("rank")}
                  >
                    Rank
                  </th>
                  <th>Player</th>
                  {data?.mapHeaders.map((h) => (
                    <th
                      key={h.sortKey}
                      className={`r ${getSortClass(h.sortKey)}`}
                      onClick={() => handleSort(h.sortKey)}
                    >
                      {h.label}
                    </th>
                  ))}
                  <th
                    className={`r ${getSortClass("total")}`}
                    onClick={() => handleSort("total")}
                  >
                    Total
                  </th>
                  <th
                    className={`improved-th ${getSortClass("improved")}`}
                    onClick={() => handleSort("improved")}
                  >
                    Last Improved
                  </th>
                </tr>
              </thead>
              <tbody>
                {data?.players.map((player, i) => (
                  <tr
                    key={i}
                    className={[
                      player.medalClass,
                      highlight === player.name ? "highlighted" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    ref={highlight === player.name ? highlightRef : undefined}
                  >
                    <td className="rank-col">{player.rank}</td>
                    <td className="player-col">
                      <div className="player-inner">
                        {player.countryISO2 && (
                          <img
                            src={`https://flagcdn.com/24x18/${player.countryISO2}.png`}
                            alt={player.countryISO2}
                            title={countryName(player.countryISO2)}
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        )}
                        <span className="player-name">{player.name}</span>
                      </div>
                    </td>
                    {player.mapTimes.map((t, j) => (
                      <td key={j} className="time-col">
                        {t !== "-" && player.mapRanks[j] > 0 && (
                          <span
                            className={`map-rank${player.mapRanks[j] <= 3 ? ` map-rank-${["gold", "silver", "bronze"][player.mapRanks[j] - 1]}` : ""}`}
                          >
                            ({player.mapRanks[j]})
                          </span>
                        )}{" "}
                        {t}
                      </td>
                    ))}
                    <td className="total-col">
                      <div>{player.totalTime}</div>
                      {player.diffToFirst !== "-" && (
                        <div className="diff-text">{player.diffToFirst}</div>
                      )}
                    </td>
                    <td className="improved-col">
                      {formatRelativeTime(player.lastImprovedUnix)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination()}
        </>
      )}

      {stage === 2 && (
        <>
          <div className="stage2-section-header">
            <span className="stage2-section-title">Match Results</span>
            <span className="stage2-section-sub">
              Updated only after match completions
            </span>
          </div>
          <div className="search-row">
            <div className="search-wrap">
              <span className="search-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="15"
                  height="15"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
              <input
                type="text"
                placeholder="Search players..."
                autoComplete="off"
                value={stage2SearchQuery}
                onChange={(e) => handleStage2Search(e.target.value)}
              />
              {stage2ShowDropdown && (
                <div className="search-dropdown">
                  {stage2SearchResults.length === 0 ? (
                    <div className="no-results">No players found</div>
                  ) : (
                    stage2SearchResults.map((r, i) => (
                      <a
                        key={i}
                        onClick={() => handleStage2SearchResultClick(r.name)}
                      >
                        <img
                          src={`https://flagcdn.com/20x15/${r.countryISO2.toLowerCase()}.png`}
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                          alt=""
                          title={countryName(r.countryISO2)}
                        />
                        <span className="sr-name">{r.name}</span>
                      </a>
                    ))
                  )}
                </div>
              )}
            </div>
            {highlight && (
              <button
                className="clear-highlight"
                onClick={() => setHighlight(null)}
              >
                Clear highlight
              </button>
            )}
          </div>
          {renderStage2()}
        </>
      )}

      {tooltip && (
        <div
          ref={tooltipRef}
          className="player-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            borderTopColor: tooltip.accent,
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}

export default App;
