import { useState, useEffect, useCallback, useRef } from "react";
import "./App.css";
import type { LeaderboardData, SearchResult } from "./types";

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

function App() {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("rank");
  const [sortDir, setSortDir] = useState("asc");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [elapsed, setElapsed] = useState("");
  const debounceRef = useRef(0);
  const highlightRef = useRef<HTMLTableRowElement>(null);
  const initializedRef = useRef(false);

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

  // Fetch data on mount and when params change; auto-refresh every 2 min
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 120000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Update URL when state changes
  useEffect(() => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (sortBy !== "rank" || sortDir !== "asc") {
      params.set("sort", sortBy);
      params.set("dir", sortDir);
    }
    if (highlight) params.set("highlight", highlight);
    const qs = params.toString();
    const url = qs ? `/?${qs}` : "/";
    window.history.replaceState(null, "", url);
  }, [page, sortBy, sortDir, highlight]);

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
  }, [highlight, data]);

  // Close search dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".search-wrap")) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

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

  const getSortClass = (key: string): string => {
    if (sortBy !== key) return "sortable";
    return `sortable ${sortDir === "asc" ? "sort-asc" : "sort-desc"}`;
  };

  if (!data) {
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

  const renderPagination = () => {
    if (data.totalPages <= 1) return null;
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
        <div className="meta">
          <span>{data.totalPlayers}</span> players &middot; Updated{" "}
          <span>{elapsed}</span> ago &middot; Page <span>{data.page}</span> of{" "}
          <span>{data.totalPages}</span>
        </div>
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
      </header>

      <div className="divider"></div>
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
              {data.mapHeaders.map((h) => (
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
            {data.players.map((player, i) => (
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
    </div>
  );
}

export default App;
