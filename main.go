package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	tmio "github.com/Johnnycyan/go-tmio-sdk"
)

// API response types

type APIResponse struct {
	Success bool    `json:"success"`
	Message string  `json:"message"`
	Payload Payload `json:"payload"`
}

type Payload struct {
	HeatAthletesMap  map[string][]HeatAthlete `json:"heatAthletesMap"`
	AthletesMap      map[string]Athlete       `json:"athletesMap"`
	EventAthletesMap map[string]EventAthlete  `json:"eventAthletesMap"`
	Pagination       Pagination               `json:"pagination"`
}

type HeatAthlete struct {
	Score          string       `json:"score"`
	Rank           int          `json:"rank"`
	EventAthleteId string       `json:"eventAthleteId"`
	Metadata       HeatMetadata `json:"metadata"`
	Laps           []Lap        `json:"laps"`
}

type HeatMetadata struct {
	Data HeatMetadataData `json:"data"`
}

type HeatMetadataData struct {
	LastUpdated    string `json:"lastUpdated"`
	AggregateRank  int    `json:"aggregateRank"`
	AggregateScore int    `json:"aggregateScore"`
}

type Lap struct {
	Name     string      `json:"name"`
	Time     string      `json:"time"`
	Metadata LapMetadata `json:"metadata"`
}

type LapMetadata struct {
	Data LapMetadataData `json:"data"`
}

type LapMetadataData struct {
	Rank    int    `json:"rank"`
	MapName string `json:"mapName"`
	ScoreMs int    `json:"scoreMs"`
}

type Athlete struct {
	AthleteId   string `json:"athleteId"`
	Name        string `json:"name"`
	Nationality string `json:"nationality"`
	ExternalId  string `json:"externalId"`
}

type EventAthlete struct {
	EventAthleteId string  `json:"eventAthleteId"`
	Rank           int     `json:"rank"`
	AthleteId      string  `json:"athleteId"`
	Athlete        Athlete `json:"athlete"`
}

type Pagination struct {
	Limit       int    `json:"limit"`
	TotalCount  int    `json:"totalCount"`
	NextCursor  string `json:"nextCursor"`
	HasNextPage bool   `json:"hasNextPage"`
}

// Cached player data

type CachedPlayer struct {
	TrackmaniaID string
	Name         string
	Nationality  string
	Rank         int
	ScoreMs      int
}

var (
	cacheMu        sync.RWMutex
	cachedPlayers  []CachedPlayer
	cachedTotal    int
	cacheUpdatedAt time.Time

	playerIDMu          sync.Mutex
	playerIDCache       = make(map[string]string)
	playerIDCacheExpiry = make(map[string]time.Time)
	playerIDCacheDur    = 5 * time.Hour
)

const baseURL = "https://p-p.redbull.com/rb-red-bullf-diving-6e-77-prod-34bf88e41923/api/v1/event/trackmania/stage1?assetId=rrn%3Acontent%3Aevent-profiles%3A8d1f88a2-451f-400f-9ba3-0b1f24dd8933&limit=10000"

func main() {
	if len(os.Args) < 2 {
		log.Fatal("Please provide the port number")
	}
	port := os.Args[1]

	go backgroundFetcher()

	http.HandleFunc("/", getLeaderboardRank)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func backgroundFetcher() {
	fetchAllPages()
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		fetchAllPages()
	}
}

func fetchAllPages() {
	var players []CachedPlayer
	var totalCount int

	pageURL := baseURL
	pageNum := 0

	for {
		pageNum++
		if pageNum > 20 {
			log.Printf("Stopping fetch after %d pages to avoid infinite loop", pageNum-1)
			break
		}
		resp, err := http.Get(pageURL)
		if err != nil {
			log.Printf("Error fetching page %d: %v", pageNum, err)
			return
		}

		var apiResp APIResponse
		err = json.NewDecoder(resp.Body).Decode(&apiResp)
		resp.Body.Close()
		if err != nil {
			log.Printf("Error decoding page %d: %v", pageNum, err)
			return
		}

		if !apiResp.Success {
			log.Printf("API error on page %d: %s", pageNum, apiResp.Message)
			return
		}

		totalCount = apiResp.Payload.Pagination.TotalCount

		log.Printf("Fetched page %d: %d players (total: %d)", pageNum, 100, totalCount)

		for _, heatAthletes := range apiResp.Payload.HeatAthletesMap {
			for _, ha := range heatAthletes {
				ea, ok := apiResp.Payload.EventAthletesMap[ha.EventAthleteId]
				if !ok {
					continue
				}

				athlete, ok := apiResp.Payload.AthletesMap[ea.AthleteId]
				if !ok {
					athlete = ea.Athlete
				}

				tmID := strings.TrimPrefix(athlete.ExternalId, "trackmania_")
				scoreMs, _ := strconv.Atoi(ha.Score)

				players = append(players, CachedPlayer{
					TrackmaniaID: tmID,
					Name:         athlete.Name,
					Nationality:  athlete.Nationality,
					Rank:         ha.Rank,
					ScoreMs:      scoreMs,
				})
			}
		}

		if !apiResp.Payload.Pagination.HasNextPage {
			break
		}

		pageURL = baseURL + "&cursor=" + url.QueryEscape(apiResp.Payload.Pagination.NextCursor)
	}

	sort.Slice(players, func(i, j int) bool {
		return players[i].Rank < players[j].Rank
	})

	cacheMu.Lock()
	cachedPlayers = players
	cachedTotal = totalCount
	cacheUpdatedAt = time.Now()
	cacheMu.Unlock()

	log.Printf("Cache updated: %d players fetched (total: %d)", len(players), totalCount)
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

func getLeaderboardRank(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprint(w, "User not found in the top 2000 players")
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
		http.Error(w, "Player not found in the top 2000 players", http.StatusNotFound)
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

	updatedSection = ""

	fmt.Fprintf(w, "%s%s%s%s%s", usernameSection, rankSection, topSection, updatedSection, abovePlayerSection)
}

func getCachedPlayerID(username string) (string, error) {
	playerIDMu.Lock()
	defer playerIDMu.Unlock()

	if id, found := playerIDCache[username]; found {
		if time.Now().Before(playerIDCacheExpiry[username]) {
			return id, nil
		}
		delete(playerIDCache, username)
		delete(playerIDCacheExpiry, username)
	}

	id, err := tmio.GetPlayerID(username)
	if err != nil {
		return "", err
	}

	playerIDCache[username] = id
	playerIDCacheExpiry[username] = time.Now().Add(playerIDCacheDur)
	return id, nil
}
