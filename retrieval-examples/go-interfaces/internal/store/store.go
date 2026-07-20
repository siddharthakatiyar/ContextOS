package store

type User struct {
	ID    string
	Email string
}

type UserStore interface {
	GetUser(id string) (*User, error)
	CreateUser(user *User) error
}
