FROM python:3.12-slim

WORKDIR /app
COPY . .

ENV PARTYLINK_HTTP=1
EXPOSE 8765

CMD ["python3", "server.py"]
