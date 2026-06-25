#!/usr/bin/env bash
# post-reply.sh — WRITE. Post a reply to one PR review comment, optionally resolve.
#
# Only invoke AFTER the user has approved this specific reply via AskUserQuestion.
#
# Usage:  post-reply.sh <pr> <comment_id> <thread_id> <reply_file> [--resolve] [owner/repo]
#         <reply_file>  path to a file holding the reply body (so multiline/markdown is safe)
#         --resolve     also resolve the review thread after replying
# Output: the reply's html_url on stdout.
set -euo pipefail

PR="${1:?usage: post-reply.sh <pr> <comment_id> <thread_id> <reply_file> [--resolve] [owner/repo]}"
COMMENT_ID="${2:?missing comment_id}"
THREAD_ID="${3:?missing thread_id}"
REPLY_FILE="${4:?missing reply_file}"
shift 4

RESOLVE=0
REPO=""
for arg in "$@"; do
  case "$arg" in
    --resolve) RESOLVE=1 ;;
    */*)       REPO="$arg" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

[[ -f "$REPLY_FILE" ]] || { echo "reply file not found: $REPLY_FILE" >&2; exit 2; }

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

# REST reply to the comment thread (--field reads body from file via @).
URL="$(gh api "repos/$OWNER/$NAME/pulls/$PR/comments/$COMMENT_ID/replies" \
  --method POST \
  --field "body=@$REPLY_FILE" \
  -q .html_url)"
echo "$URL"

if [[ "$RESOLVE" -eq 1 ]]; then
  gh api graphql -f threadId="$THREAD_ID" -f query='
    mutation($threadId:ID!){
      resolveReviewThread(input:{threadId:$threadId}){
        thread{ id isResolved }
      }
    }' >/dev/null
  echo "resolved thread $THREAD_ID" >&2
fi
