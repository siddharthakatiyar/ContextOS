package main

import (
	"fmt"
	"github.com/example/app/internal/store"
)

func main() {
	var db store.UserStore = store.NewPostgresStore()
	
	user, err := db.GetUser("123")
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	
	fmt.Println("Loaded user:", user.Email)
}
