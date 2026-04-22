#!/usr/bin/env bash
set -euo pipefail

level="${1:-}"
if [[ "$level" != "major" && "$level" != "minor" && "$level" != "patch" ]]; then
  echo "Usage: bump <major|minor|patch>"
  exit 1
fi

# Read current version from manifest.json
current=$(grep -o '"version": *"[^"]*"' manifest.json | head -1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r major minor patch <<< "$current"

case "$level" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac

new="$major.$minor.$patch"
echo "Bumping $current → $new"

# Update manifest.json
sed -i '' "s/\"version\": *\"$current\"/\"version\": \"$new\"/" manifest.json

# Update package.json
sed -i '' "s/\"version\": *\"$current\"/\"version\": \"$new\"/" package.json

# Update versions.json — add new version mapped to current minAppVersion
min_app=$(grep -o '"minAppVersion": *"[^"]*"' manifest.json | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
# Add new entry before the closing brace
sed -i '' "s/}$/,\n  \"$new\": \"$min_app\"\n}/" versions.json

# Commit, tag, push
git add manifest.json package.json versions.json
git commit -m "v$new"
git tag "$new"
git push origin HEAD --tags

# Watch the CI run triggered by the tag, then open the release
echo "Watching CI…"
gh run watch --exit-status
gh release view "$new" --web
