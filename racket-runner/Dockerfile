FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends racket python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /runner
COPY server.py evaluate.rkt ./
USER 65534:65534
ENV HOME=/tmp
EXPOSE 8010
CMD ["python3", "-I", "server.py"]
