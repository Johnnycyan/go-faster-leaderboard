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
	Players []Players `json:"Players"`
}
type Global struct {
	Rank      int       `json:"Rank"`
	Score     int       `json:"Score"`
	Timestamp time.Time `json:"Timestamp"`
}
type Records struct {
	Global Global `json:"__global"`
}
type Players struct {
	AccountID   string  `json:"AccountId"`
	Name        string  `json:"Name"`
	CountryIso2 string  `json:"CountryIso2"`
	Records     Records `json:"Records"`
}

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

func getTotalPlayers(leaderboard *Leaderboard) int {
	return len(leaderboard.Players)
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

	id, err := tmio.GetPlayerID(username)
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

	rank := player.Records.Global.Rank

	totalPlayers := getTotalPlayers(leaderboard)

	percentage := getTopPercentage(totalPlayers, rank)

	print := fmt.Sprintf("%d out of %d (Top %.2f%%)", rank, totalPlayers, percentage)

	fmt.Fprint(w, print)
}
