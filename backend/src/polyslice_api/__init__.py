def main() -> None:
    import uvicorn

    uvicorn.run("polyslice_api.main:app", host="127.0.0.1", port=8001, reload=True)
