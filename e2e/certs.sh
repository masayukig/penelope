#!/bin/sh
# Makes the test's keys afresh in the directory given (e2e/.run/): the
# Sentinel's CA, a CA for the outside world and the outside's certificate,
# and the real keys that only the Sentinel, the backend and the fakes hold.
set -eu
dir="$1"
mkdir -p "$dir"
cd "$dir"

ca() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
    -subj "/CN=$2" -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -keyout "$1.key" -out "$1.crt" 2>/dev/null
}
ca sentinel-ca "penelope e2e Sentinel CA"
ca outside-ca "penelope e2e outside CA"

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=outside" \
  -keyout outside.key -out outside.csr 2>/dev/null
printf 'subjectAltName=DNS:model.example.com,DNS:github.com,DNS:api.github.com,DNS:plain.example.net\nextendedKeyUsage=serverAuth\n' > outside.ext
openssl x509 -req -in outside.csr -CA outside-ca.crt -CAkey outside-ca.key -CAcreateserial -days 2 \
  -extfile outside.ext -out outside.crt 2>/dev/null
rm -f outside.csr outside.ext outside-ca.srl

for name in model-key backend-token github-client-secret; do
  openssl rand -hex 24 > "$name"
done
# The containers run as different users; these are the test's own throwaway keys.
chmod 0644 ./*
