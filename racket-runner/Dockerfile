FROM ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254
RUN apt-get update && apt-get install -y --no-install-recommends racket python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /runner
COPY server.py evaluate.rkt ./
RUN raco make evaluate.rkt
USER 65534:65534
ENV HOME=/tmp
EXPOSE 8010
CMD ["python3", "-I", "server.py"]
