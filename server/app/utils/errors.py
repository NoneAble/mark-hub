from fastapi import HTTPException, status


def api_error(code: str, message: str, status_code: int = 400, details=None) -> HTTPException:
    body = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return HTTPException(status_code=status_code, detail=body)


def not_found(message: str = "Not found") -> HTTPException:
    return api_error("not_found", message, status.HTTP_404_NOT_FOUND)
