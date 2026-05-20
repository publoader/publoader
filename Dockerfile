FROM python:3.10-bullseye

WORKDIR /app

# git is needed for the /add commit-back path and is otherwise convenient
# for in-container debugging.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENTRYPOINT [ "python", "run.py" ]
