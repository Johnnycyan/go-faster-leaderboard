package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	tmio "github.com/Johnnycyan/go-tmio-sdk"
)

type Leaderboard struct {
	Players  []Players `json:"Players"`
	Metadata Metadata  `json:"Metadata"`
	Count    int       `json:"Count"`
}
type Records struct {
	Rank      int       `json:"Rank"`
	Score     int       `json:"Score"`
	Timestamp time.Time `json:"Timestamp"`
	SortOrder int       `json:"SortOrder"`
}
type Players struct {
	AccountID   string    `json:"Id"`
	Name        string    `json:"Name"`
	CountryIso2 string    `json:"CountryIso2"`
	Records     []Records `json:"Records"`
}

type Metadata struct {
	Timestamp time.Time `json:"Timestamp"`
}

var (
	cache         = make(map[string]string)
	cacheExpiry   = make(map[string]time.Time)
	cacheDuration = 5 * time.Hour
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("Please provide the port number")
	}
	port := os.Args[1]
	http.HandleFunc("/", getLeaderboardRank)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func fetchLeaderboardData() (*Leaderboard, error) {
	url := "https://d3px9r1nfh13li.cloudfront.net/stage1-official.latest.json"
	resp, err := http.Get(url)
	if err != nil {
		return nil, nil
	}
	defer resp.Body.Close()

	var leaderboard Leaderboard
	err = json.NewDecoder(resp.Body).Decode(&leaderboard)
	if err != nil {
		return nil, err
	}
	return &leaderboard, nil
}

func searchLeaderboard(leaderboard *Leaderboard, id string) (Players, error) {
	for _, player := range leaderboard.Players {
		if player.AccountID == id {
			return player, nil
		}
	}
	return Players{}, fmt.Errorf("player not found")
}

func getTopPercentage(total int, rank int) float64 {
	return float64(rank) / float64(total) * 100
}

func getLeaderboardRank(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprint(w, "User not found")
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

	id, err := getCachedPlayerID(username)
	if err != nil {
		log.Println(err)
		http.Error(w, "Could not get player id", http.StatusInternalServerError)
		return
	}

	leaderboard, err := fetchLeaderboardData()
	if err != nil {
		log.Println(err)
		http.Error(w, "Could not fetch leaderboard data", http.StatusInternalServerError)
		return
	}

	player, err := searchLeaderboard(leaderboard, id)
	if err != nil {
		log.Println(err)
		http.Error(w, "Player not found", http.StatusNotFound)
		return
	}

	rank := player.Records[3].Rank

	timestamp := leaderboard.Metadata.Timestamp

	relativeTime := time.Since(timestamp)

	relativeTime = relativeTime.Round(time.Second)

	totalPlayers := leaderboard.Count

	percentage := getTopPercentage(totalPlayers, rank)

	var usernameSection string
	if displayName == "true" {
		usernameSection = fmt.Sprintf("%s is rank ", player.Name)
	} else {
		usernameSection = ""
	}

	var rankSection string
	if total == "false" {
		rankSection = fmt.Sprint(rank)
	} else {
		rankSection = fmt.Sprintf("%d out of %d", rank, totalPlayers)
	}

	var topSection string
	if top == "false" {
		topSection = ""
	} else {
		topSection = fmt.Sprintf(" (Top %.2f%%)", percentage)
	}

	var updatedSection string
	if updated == "false" {
		updatedSection = ""
	} else {
		updatedSection = fmt.Sprintf(" [Updated %s ago]", relativeTime)
	}

	print := fmt.Sprintf("%s%s%s%s", usernameSection, rankSection, topSection, updatedSection)

	fmt.Fprint(w, print)
}

func getCachedPlayerID(username string) (string, error) {
	if id, found := cache[username]; found {
		if time.Now().Before(cacheExpiry[username]) {
			return id, nil
		}
		delete(cache, username)
		delete(cacheExpiry, username)
	}

	id, err := tmio.GetPlayerID(username)
	if err != nil {
		return "", err
	}

	cache[username] = id
	cacheExpiry[username] = time.Now().Add(cacheDuration)
	return id, nil
}
