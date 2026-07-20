from fastapi import APIRouter, Depends
from models.user import User
from dependencies import get_current_user, get_db_session

router = APIRouter()

@router.get("/me", response_model=User)
async def read_users_me(
    current_user: User = Depends(get_current_user),
    db = Depends(get_db_session)
):
    return current_user
