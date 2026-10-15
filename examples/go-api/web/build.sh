#!/bin/sh
set -eu
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
sed -e "s/__BUILD_ID__/${BUILD_ID:?BUILD_ID must be set}/" \
  -e "s/__EXAMPLE_PUBLIC_NAME__/${EXAMPLE_PUBLIC_NAME:?EXAMPLE_PUBLIC_NAME must be set}/" \
  index.html > dist/index.html
