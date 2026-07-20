from fastapi import Header, HTTPException
from models.user import User

def get_db_session():
    # Mock database session
    return {"connected": True}

async def get_current_user(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    # Mock user extraction
    return User(id=1, username="admin", email="admin@example.com", hashed_password="***")
