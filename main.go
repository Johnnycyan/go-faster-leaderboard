package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	tmio "github.com/Johnnycyan/go-tmio-sdk"
	"github.com/gorilla/websocket"

	"github.com/joho/godotenv"
)

//go:embed frontend/dist
var frontendFS embed.FS

// API response types

type MapInfo struct {
	UID  string `json:"uid"`
	Name string `json:"name"`
}

type Stage struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Status         string    `json:"status"`
	ScoringType    string    `json:"scoringType"`
	ScheduledTime  string    `json:"scheduledTime"`
	CompletionTime string    `json:"completionTime"`
	LastScan       LastScan  `json:"lastScan"`
	Players        []Player  `json:"players"`
	Maps           []MapInfo `json:"maps"`
}

type LastScan struct {
	ID           string `json:"id"`
	StartedAt    string `json:"startedAt"`
	CompletedAt  string `json:"completedAt"`
	IsSuccessful bool   `json:"isSuccessful"`
}

type Player struct {
	Position      int          `json:"position"`
	PlayerInfo    PlayerInfo   `json:"player"`
	Records       []Record     `json:"records"`
	Rank          int          `json:"rank"`
	Score         int          `json:"score"`
	InCompetition bool         `json:"inCompetition"`
	UpdatedAt     string       `json:"updatedAt"`
}

type PlayerInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Country     string `json:"country"`
	CountryISO2 string `json:"countryIso2"`
}

type Record struct {
	Position  int    `json:"position"`
	Score     int    `json:"score"`
	MapUID    string `json:"mapUid"`
	Timestamp string `json:"timestamp"`
	IsActive  bool   `json:"isActive"`
}

// Cached player data

type CachedRecord struct {
	MapUID    string
	ScoreMs   int
	Timestamp string
}

type CachedPlayer struct {
	TrackmaniaID string
	Name         string
	Country      string
	CountryISO2  string
	Rank         int
	ScoreMs      int
	Records      []CachedRecord
}

var (
	cacheMu        sync.RWMutex
	cachedPlayers  []CachedPlayer
	cachedTotal    int
	cacheUpdatedAt time.Time
	cachedMaps     []MapInfo

	playerIDMu       sync.Mutex
	playerIDCacheDur = 24 * time.Hour

	scanMaxAge         time.Duration
	retryPollInterval  = 2 * time.Minute
)

// WebSocket hub

const (
	wsWriteWait  = 10 * time.Second
	wsPingPeriod = 30 * time.Second
	wsPongWait   = 60 * time.Second
)

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type wsClient struct {
	hub  *wsHub
	conn *websocket.Conn
	send chan []byte
}

type wsHub struct {
	clients    map[*wsClient]bool
	broadcast  chan []byte
	register   chan *wsClient
	unregister chan *wsClient
	mu         sync.Mutex
}

var hub = &wsHub{
	clients:    make(map[*wsClient]bool),
	broadcast:  make(chan []byte, 16),
	register:   make(chan *wsClient, 16),
	unregister: make(chan *wsClient, 16),
}

func (h *wsHub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			h.mu.Lock()
			for client := range h.clients {
				select {
				case client.send <- msg:
				default:
					delete(h.clients, client)
					close(client.send)
				}
			}
			h.mu.Unlock()
		}
	}
}

func (c *wsClient) writePump() {
	ticker := time.NewTicker(wsPingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *wsClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			break
		}
	}
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}
	client := &wsClient{hub: hub, conn: conn, send: make(chan []byte, 8)}
	hub.register <- client
	go client.writePump()
	go client.readPump()
}

const cacheDir = "cache"

// Disk cache types

type DiskLeaderboardCache struct {
	Players   []CachedPlayer `json:"players"`
	Total     int            `json:"total"`
	UpdatedAt time.Time      `json:"updatedAt"`
	Maps      []MapInfo      `json:"maps"`
}

type PlayerIDEntry struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func saveLeaderboardCache(players []CachedPlayer, total int, updatedAt time.Time, maps []MapInfo) {
	data := DiskLeaderboardCache{
		Players:   players,
		Total:     total,
		UpdatedAt: updatedAt,
		Maps:      maps,
	}
	b, err := json.Marshal(data)
	if err != nil {
		log.Printf("Error marshaling leaderboard cache: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "leaderboard.json"), b, 0644); err != nil {
		log.Printf("Error writing leaderboard cache: %v", err)
	}
}

func loadLeaderboardCache() {
	b, err := os.ReadFile(filepath.Join(cacheDir, "leaderboard.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Error reading leaderboard cache: %v", err)
		}
		return
	}
	var data DiskLeaderboardCache
	if err := json.Unmarshal(b, &data); err != nil {
		log.Printf("Error unmarshaling leaderboard cache: %v", err)
		return
	}
	cacheMu.Lock()
	cachedPlayers = data.Players
	cachedTotal = data.Total
	cacheUpdatedAt = data.UpdatedAt
	cachedMaps = data.Maps
	cacheMu.Unlock()
	log.Printf("Loaded leaderboard cache from disk: %d players", data.Total)
}

func loadPlayerIDCache() map[string]PlayerIDEntry {
	b, err := os.ReadFile(filepath.Join(cacheDir, "playerids.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Error reading player ID cache: %v", err)
		}
		return make(map[string]PlayerIDEntry)
	}
	var data map[string]PlayerIDEntry
	if err := json.Unmarshal(b, &data); err != nil {
		log.Printf("Error unmarshaling player ID cache: %v", err)
		return make(map[string]PlayerIDEntry)
	}
	return data
}

func savePlayerIDCache(cache map[string]PlayerIDEntry) {
	b, err := json.Marshal(cache)
	if err != nil {
		log.Printf("Error marshaling player ID cache: %v", err)
		return
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "playerids.json"), b, 0644); err != nil {
		log.Printf("Error writing player ID cache: %v", err)
	}
}

var apiURL string

func main() {
	_ = godotenv.Load()
	apiURL = os.Getenv("API_URL")
	if apiURL == "" {
		log.Fatal("API_URL environment variable is not set")
	}
	if len(os.Args) < 2 {
		log.Fatal("Please provide the port number")
	}
	port := os.Args[1]

	scanMaxAgeMin := 13
	if v := os.Getenv("SCAN_MAX_AGE_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			scanMaxAgeMin = n
		}
	}
	scanMaxAge = time.Duration(scanMaxAgeMin) * time.Minute
	log.Printf("Scan max age: %d minutes", scanMaxAgeMin)

	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		log.Fatalf("Failed to create cache directory: %v", err)
	}
	loadLeaderboardCache()

	go hub.run()
	go backgroundFetcher()

	http.HandleFunc("/ws", wsHandler)
	http.HandleFunc("/cmd", getLeaderboardRank)
	http.HandleFunc("/api/search", searchPlayers)
	http.HandleFunc("/api/leaderboard", apiLeaderboard)

	distFS, err := fs.Sub(frontendFS, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	http.Handle("/", spaHandler(http.FileServer(http.FS(distFS)), distFS))

	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func spaHandler(fileServer http.Handler, fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(fsys, path); err != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}

func backgroundFetcher() {
	for {
		lastScanTime, fresh := fetchLeaderboard()
		if fresh {
			// Schedule next poll for when the scan will be scanMaxAge old
			waitDur := time.Until(lastScanTime.Add(scanMaxAge))
			if waitDur < 0 {
				waitDur = 0
			}
			log.Printf("Next poll in %v (at %v)", waitDur.Round(time.Second), lastScanTime.Add(scanMaxAge).Format(time.RFC3339))
			time.Sleep(waitDur)
		} else {
			// Data is stale, retry in 2 minutes
			age := time.Since(lastScanTime).Round(time.Second)
			log.Printf("Scan data is stale (age: %v), retrying in %v", age, retryPollInterval)
			time.Sleep(retryPollInterval)
		}
	}
}

type APIResponse struct {
	Stages [][]Stage `json:"stages"`
}

// fetchLeaderboard fetches from the API, updates the cache, and returns the
// lastScanTime from the response along with a boolean indicating whether the
// scan data is fresh (age < scanMaxAge). Broadcasts "refresh" to WS clients
// when fresh new data is received.
func fetchLeaderboard() (lastScanTime time.Time, fresh bool) {
	resp, err := http.Get(apiURL)
	if err != nil {
		log.Printf("Error fetching leaderboard: %v", err)
		return time.Now(), false
	}
	defer resp.Body.Close()

	var apiResp APIResponse
	if err = json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		log.Printf("Error decoding leaderboard: %v", err)
		return time.Now(), false
	}

	if len(apiResp.Stages) == 0 || len(apiResp.Stages[0]) == 0 {
		log.Println("No stages found in API response")
		return time.Now(), false
	}

	stage := apiResp.Stages[0][0]

	if stage.LastScan.CompletedAt != "" {
		lastScanTime, err = time.Parse(time.RFC3339, stage.LastScan.CompletedAt)
		if err != nil {
			log.Printf("Error parsing lastScan completedAt: %v", err)
			lastScanTime = time.Now()
		}
	} else {
		lastScanTime = time.Now()
	}

	maps := stage.Maps

	var players []CachedPlayer
	for _, p := range stage.Players {
		if p.Rank == -1 {
			continue
		}
		var records []CachedRecord
		for _, r := range p.Records {
			records = append(records, CachedRecord{
				MapUID:    r.MapUID,
				ScoreMs:   r.Score,
				Timestamp: r.Timestamp,
			})
		}
		players = append(players, CachedPlayer{
			TrackmaniaID: p.PlayerInfo.ID,
			Name:         p.PlayerInfo.Name,
			Country:      p.PlayerInfo.Country,
			CountryISO2:  p.PlayerInfo.CountryISO2,
			Rank:         p.Rank,
			ScoreMs:      p.Score,
			Records:      records,
		})
	}

	fresh = time.Since(lastScanTime) < scanMaxAge

	cacheMu.Lock()
	prevUpdatedAt := cacheUpdatedAt
	cachedPlayers = players
	cachedTotal = len(players)
	cacheUpdatedAt = lastScanTime
	cachedMaps = maps
	cacheMu.Unlock()

	saveLeaderboardCache(players, len(players), lastScanTime, maps)

	log.Printf("Cache updated: %d players fetched (last scan: %s, fresh: %v)", len(players), lastScanTime.Format(time.RFC3339), fresh)

	// Notify WS clients only when fresh data with a newer scan time arrives
	if fresh && lastScanTime.After(prevUpdatedAt) {
		hub.broadcast <- []byte("refresh")
	}

	return lastScanTime, fresh
}

func getTopPercentage(total int, rank int) float64 {
	return float64(rank) / float64(total) * 100
}

func convertMillisecondsToSeconds(milliseconds int) time.Duration {
	return time.Duration(milliseconds) * time.Millisecond
}

func formatDuration(d time.Duration) string {
	minutes := int(d.Minutes())
	seconds := int(d.Seconds()) % 60
	milliseconds := int(d.Milliseconds()) % 1000
	if minutes > 0 {
		return fmt.Sprintf("%dm%ds%dms", minutes, seconds, milliseconds)
	} else if seconds > 0 {
		return fmt.Sprintf("%ds%dms", seconds, milliseconds)
	}
	return fmt.Sprintf("%dms", milliseconds)
}

const playersPerPage = 50

func formatRaceTime(ms int) string {
	if ms <= 0 {
		return "-"
	}
	minutes := ms / 60000
	seconds := (ms % 60000) / 1000
	millis := ms % 1000
	if minutes > 0 {
		return fmt.Sprintf("%d:%02d.%03d", minutes, seconds, millis)
	}
	return fmt.Sprintf("%d.%03d", seconds, millis)
}

func formatDiffTime(ms int) string {
	if ms <= 0 {
		return "-"
	}
	return "+" + formatRaceTime(ms)
}

func latestRecordUnix(p CachedPlayer) int64 {
	var latest int64
	for _, rec := range p.Records {
		if rec.Timestamp != "" {
			t, err := time.Parse(time.RFC3339, rec.Timestamp)
			if err == nil && t.Unix() > latest {
				latest = t.Unix()
			}
		}
	}
	return latest
}

// JSON API types

type APILeaderboardRow struct {
	Rank             int      `json:"rank"`
	Name             string   `json:"name"`
	CountryISO2      string   `json:"countryISO2"`
	MapTimes         []string `json:"mapTimes"`
	MapTimesMs       []int    `json:"mapTimesMs"`
	MapRanks         []int    `json:"mapRanks"`
	TotalTime        string   `json:"totalTime"`
	TotalMs          int      `json:"totalMs"`
	DiffToFirst      string   `json:"diffToFirst"`
	MedalClass       string   `json:"medalClass"`
	LastImprovedUnix int64    `json:"lastImprovedUnix"`
}

type APIMapHeader struct {
	Label   string `json:"label"`
	SortKey string `json:"sortKey"`
}

type APILeaderboardResponse struct {
	Players       []APILeaderboardRow `json:"players"`
	MapHeaders    []APIMapHeader      `json:"mapHeaders"`
	SortBy        string              `json:"sortBy"`
	SortDir       string              `json:"sortDir"`
	Page          int                 `json:"page"`
	TotalPages    int                 `json:"totalPages"`
	UpdatedAtUnix int64               `json:"updatedAtUnix"`
	TotalPlayers  int                 `json:"totalPlayers"`
}

func apiLeaderboard(w http.ResponseWriter, r *http.Request) {
	cacheMu.RLock()
	players := cachedPlayers
	totalPlayers := cachedTotal
	updatedAt := cacheUpdatedAt
	maps := cachedMaps
	cacheMu.RUnlock()

	if len(players) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "Leaderboard data not yet available"})
		return
	}

	sortBy := r.URL.Query().Get("sort")
	sortDir := r.URL.Query().Get("dir")
	if sortBy == "" {
		sortBy = "rank"
	}
	if sortDir == "" {
		if sortBy == "improved" {
			sortDir = "desc"
		} else {
			sortDir = "asc"
		}
	}

	// Always compute firstScore from competition rank 1 before any re-sort
	firstScore := 0
	for _, p := range players {
		if p.Rank == 1 {
			firstScore = p.ScoreMs
			break
		}
	}

	// Sort a copy so the cache is untouched
	sortedPlayers := make([]CachedPlayer, len(players))
	copy(sortedPlayers, players)
	sort.SliceStable(sortedPlayers, func(i, j int) bool {
		pi, pj := sortedPlayers[i], sortedPlayers[j]
		var vi, vj int
		switch {
		case sortBy == "total":
			vi, vj = pi.Rank, pj.Rank
		case sortBy == "improved":
			vi = int(latestRecordUnix(pi))
			vj = int(latestRecordUnix(pj))
		case strings.HasPrefix(sortBy, "map"):
			mapIdx, err := strconv.Atoi(sortBy[3:])
			if err == nil && mapIdx >= 0 && mapIdx < len(maps) {
				uid := maps[mapIdx].UID
				vi, vj = 999999999, 999999999
				for _, rec := range pi.Records {
					if rec.MapUID == uid {
						vi = rec.ScoreMs
						break
					}
				}
				for _, rec := range pj.Records {
					if rec.MapUID == uid {
						vj = rec.ScoreMs
						break
					}
				}
			} else {
				vi, vj = pi.Rank, pj.Rank
			}
		default: // rank
			vi, vj = pi.Rank, pj.Rank
		}
		if sortDir == "desc" {
			return vi > vj
		}
		return vi < vj
	})

	pageStr := r.URL.Query().Get("page")
	page := 1
	if pageStr != "" {
		if p, err := strconv.Atoi(pageStr); err == nil && p > 0 {
			page = p
		}
	}

	totalPages := (totalPlayers + playersPerPage - 1) / playersPerPage
	if page > totalPages {
		page = totalPages
	}

	start := (page - 1) * playersPerPage
	end := start + playersPerPage
	if end > totalPlayers {
		end = totalPlayers
	}
	pagePlayers := sortedPlayers[start:end]

	mapIndex := make(map[string]int)
	for i, m := range maps {
		mapIndex[m.UID] = i
	}

	mapHeaders := make([]APIMapHeader, len(maps))
	for i, m := range maps {
		mapHeaders[i] = APIMapHeader{Label: m.Name, SortKey: fmt.Sprintf("map%d", i)}
	}

	// Compute per-map ranks from ALL players (before pagination)
	// mapPlayerRanks[mapUID][playerID] = rank
	mapPlayerRanks := make(map[string]map[string]int)
	for _, m := range maps {
		type entry struct {
			pID   string
			score int
		}
		var entries []entry
		for _, p := range players {
			for _, rec := range p.Records {
				if rec.MapUID == m.UID && rec.ScoreMs > 0 {
					entries = append(entries, entry{pID: p.TrackmaniaID, score: rec.ScoreMs})
					break
				}
			}
		}
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].score < entries[j].score
		})
		ranks := make(map[string]int, len(entries))
		for i, e := range entries {
			ranks[e.pID] = i + 1
		}
		mapPlayerRanks[m.UID] = ranks
	}

	rows := make([]APILeaderboardRow, len(pagePlayers))
	for i, p := range pagePlayers {
		mapTimes := make([]string, len(maps))
		mapTimesMs := make([]int, len(maps))
		mapRanks := make([]int, len(maps))
		for j := range mapTimes {
			mapTimes[j] = "-"
			mapTimesMs[j] = 999999999
		}
		for _, rec := range p.Records {
			if idx, ok := mapIndex[rec.MapUID]; ok {
				mapTimes[idx] = formatRaceTime(rec.ScoreMs)
				mapTimesMs[idx] = rec.ScoreMs
				if ranks, ok2 := mapPlayerRanks[rec.MapUID]; ok2 {
					mapRanks[idx] = ranks[p.TrackmaniaID]
				}
			}
		}

		medalClass := ""
		switch p.Rank {
		case 1:
			medalClass = "gold"
		case 2:
			medalClass = "silver"
		case 3:
			medalClass = "bronze"
		}

		diff := "-"
		if p.Rank > 1 && firstScore > 0 {
			diff = formatDiffTime(p.ScoreMs - firstScore)
		}

		var lastImprovedUnix int64
		for _, rec := range p.Records {
			if rec.Timestamp != "" {
				t, err := time.Parse(time.RFC3339, rec.Timestamp)
				if err == nil && t.Unix() > lastImprovedUnix {
					lastImprovedUnix = t.Unix()
				}
			}
		}

		rows[i] = APILeaderboardRow{
			Rank:             p.Rank,
			Name:             p.Name,
			CountryISO2:      strings.ToLower(p.CountryISO2),
			MapTimes:         mapTimes,
			MapTimesMs:       mapTimesMs,
			MapRanks:         mapRanks,
			TotalTime:        formatRaceTime(p.ScoreMs),
			TotalMs:          p.ScoreMs,
			DiffToFirst:      diff,
			MedalClass:       medalClass,
			LastImprovedUnix: lastImprovedUnix,
		}
	}

	resp := APILeaderboardResponse{
		Players:       rows,
		MapHeaders:    mapHeaders,
		SortBy:        sortBy,
		SortDir:       sortDir,
		Page:          page,
		TotalPages:    totalPages,
		UpdatedAtUnix: updatedAt.Unix(),
		TotalPlayers:  totalPlayers,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

type SearchResult struct {
	Rank        int    `json:"rank"`
	Name        string `json:"name"`
	CountryISO2 string `json:"countryISO2"`
	Page        int    `json:"page"`
}

func searchPlayers(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "[]")
		return
	}

	cacheMu.RLock()
	players := cachedPlayers
	cacheMu.RUnlock()

	qLower := strings.ToLower(q)
	var exact, fuzzy []SearchResult
	for i, p := range players {
		nameLower := strings.ToLower(p.Name)
		page := (i / playersPerPage) + 1
		result := SearchResult{
			Rank:        p.Rank,
			Name:        p.Name,
			CountryISO2: strings.ToLower(p.CountryISO2),
			Page:        page,
		}
		if strings.Contains(nameLower, qLower) {
			exact = append(exact, result)
		} else if fuzzyMatchStr(qLower, nameLower) {
			fuzzy = append(fuzzy, result)
		}
		if len(exact)+len(fuzzy) >= 50 {
			break
		}
	}

	results := append(exact, fuzzy...)
	if len(results) > 20 {
		results = results[:20]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

func fuzzyMatchStr(query, target string) bool {
	qi := 0
	for i := 0; i < len(target) && qi < len(query); i++ {
		if target[i] == query[qi] {
			qi++
		}
	}
	return qi == len(query)
}

func getLeaderboardRank(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprint(w, "User not found in the leaderboard")
		}
	}()

	username := r.URL.Query().Get("username")
	if username == "" {
		http.Error(w, "username is required", http.StatusBadRequest)
		return
	}

	top := r.URL.Query().Get("top")
	total := r.URL.Query().Get("total")
	updated := r.URL.Query().Get("updated")
	displayName := r.URL.Query().Get("displayName")
	above := r.URL.Query().Get("above")

	id, err := getCachedPlayerID(username)
	if err != nil {
		log.Println(err)
		http.Error(w, "Could not get player id", http.StatusInternalServerError)
		return
	}

	cacheMu.RLock()
	players := cachedPlayers
	totalPlayers := cachedTotal
	updatedAt := cacheUpdatedAt
	cacheMu.RUnlock()

	if len(players) == 0 {
		http.Error(w, "Leaderboard data not yet available", http.StatusServiceUnavailable)
		return
	}

	var player *CachedPlayer
	var index int
	for i, p := range players {
		if p.TrackmaniaID == id {
			player = &players[i]
			index = i
			break
		}
	}

	if player == nil {
		http.Error(w, "Player not found in the leaderboard", http.StatusNotFound)
		return
	}

	rank := player.Rank
	score := convertMillisecondsToSeconds(player.ScoreMs)
	relativeTime := time.Since(updatedAt).Round(time.Second)
	percentage := getTopPercentage(totalPlayers, rank)

	var usernameSection string
	if displayName == "true" {
		usernameSection = fmt.Sprintf("%s is rank ", player.Name)
	}

	var rankSection string
	if total == "false" {
		rankSection = fmt.Sprint(rank)
	} else {
		rankSection = fmt.Sprintf("%d out of %d", rank, totalPlayers)
	}

	var topSection string
	if top != "false" {
		topSection = fmt.Sprintf(" (Top %.2f%%)", percentage)
	}

	var abovePlayerSection string
	if above == "true" && rank > 1 && index > 0 {
		abovePlayer := players[index-1]
		abovePlayerScore := convertMillisecondsToSeconds(abovePlayer.ScoreMs)
		timeDifference := score - abovePlayerScore
		abovePlayerSection = fmt.Sprintf(" +%s to rank %d %s", formatDuration(timeDifference), abovePlayer.Rank, abovePlayer.Name)
	}

	var updatedSection string
	if updated != "false" {
		updatedSection = fmt.Sprintf(" [Updated %s ago]", relativeTime)
	}

	fmt.Fprintf(w, "%s%s%s%s%s", usernameSection, rankSection, topSection, abovePlayerSection, updatedSection)
}

func getCachedPlayerID(username string) (string, error) {
	playerIDMu.Lock()
	defer playerIDMu.Unlock()

	cache := loadPlayerIDCache()
	if entry, found := cache[username]; found {
		if time.Now().Before(entry.ExpiresAt) {
			return entry.ID, nil
		}
		delete(cache, username)
	}

	id, err := tmio.GetPlayerID(username)
	if err != nil {
		return "", err
	}

	cache[username] = PlayerIDEntry{
		ID:        id,
		ExpiresAt: time.Now().Add(playerIDCacheDur),
	}
	savePlayerIDCache(cache)
	return id, nil
}
