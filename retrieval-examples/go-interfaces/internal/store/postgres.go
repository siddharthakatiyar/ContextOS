package store

type PostgresStore struct {
	// Mock connection pool
}

func NewPostgresStore() *PostgresStore {
	return &PostgresStore{}
}

func (p *PostgresStore) GetUser(id string) (*User, error) {
	// Mock DB hit
	return &User{ID: id, Email: "test@postgres.local"}, nil
}

func (p *PostgresStore) CreateUser(user *User) error {
	return nil
}
