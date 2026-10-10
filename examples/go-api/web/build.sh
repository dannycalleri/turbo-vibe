#!/bin/sh
set -eu
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
sed "s/__BUILD_ID__/${BUILD_ID:?BUILD_ID must be set}/" index.html > dist/index.html
