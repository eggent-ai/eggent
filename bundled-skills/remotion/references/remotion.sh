#!/usr/bin/env bash
# remotion.sh - Wrapper for common Remotion operations
# Usage: remotion.sh <command> [args...]
#
# Commands:
#   init <project-name>          - Scaffold a new Remotion project (blank + tailwind)
#   render <project-dir> [comp] [output] [--props '{}'] [--width N] [--height N]
#   still <project-dir> [comp] [output] [--props '{}'] [--frame N]
#   preview <project-dir>        - Start Remotion Studio dev server
#   list <project-dir>           - List available compositions
#   upgrade <project-dir>        - Upgrade Remotion packages to latest

set -euo pipefail

CMD="${1:-help}"
shift || true

case "$CMD" in
  init)
    PROJECT_NAME="${1:?Usage: remotion.sh init <project-name>}"
    echo "Creating Remotion project: $PROJECT_NAME"
    npx --yes create-video@latest --blank --tailwind --no-skills "$PROJECT_NAME" 2>&1 || {
      # Fallback: manual scaffold if create-video doesn't support flags
      echo "Trying interactive scaffold..."
      echo -e "blank\ny\nn" | npx --yes create-video@latest "$PROJECT_NAME" 2>&1
    }
    echo "Project created at ./$PROJECT_NAME"
    echo "Next: cd $PROJECT_NAME && npm install && npm run dev"
    ;;

  render)
    PROJECT_DIR="${1:?Usage: remotion.sh render <project-dir> [composition] [output] [flags...]}"
    shift
    COMP="${1:-}"
    shift 2>/dev/null || true
    OUTPUT="${1:-}"
    shift 2>/dev/null || true

    cd "$PROJECT_DIR"

    ARGS=()
    if [ -n "$COMP" ]; then ARGS+=("$COMP"); fi
    if [ -n "$OUTPUT" ]; then ARGS+=("$OUTPUT"); fi

    # Pass remaining flags through
    ARGS+=("$@")

    npx remotion render "${ARGS[@]}" 2>&1
    ;;

  still)
    PROJECT_DIR="${1:?Usage: remotion.sh still <project-dir> [composition] [output] [flags...]}"
    shift
    COMP="${1:-}"
    shift 2>/dev/null || true
    OUTPUT="${1:-}"
    shift 2>/dev/null || true

    cd "$PROJECT_DIR"

    ARGS=()
    if [ -n "$COMP" ]; then ARGS+=("$COMP"); fi
    if [ -n "$OUTPUT" ]; then ARGS+=("$OUTPUT"); fi
    ARGS+=("$@")

    npx remotion still "${ARGS[@]}" 2>&1
    ;;

  preview)
    PROJECT_DIR="${1:?Usage: remotion.sh preview <project-dir>}"
    cd "$PROJECT_DIR"
    npm run dev 2>&1
    ;;

  list)
    PROJECT_DIR="${1:?Usage: remotion.sh list <project-dir>}"
    cd "$PROJECT_DIR"
    npx remotion compositions 2>&1
    ;;

  upgrade)
    PROJECT_DIR="${1:?Usage: remotion.sh upgrade <project-dir>}"
    cd "$PROJECT_DIR"
    npx remotion upgrade 2>&1
    ;;

  help|*)
    echo "remotion.sh - Remotion video toolkit"
    echo ""
    echo "Commands:"
    echo "  init <name>                    Scaffold new project"
    echo "  render <dir> [comp] [out]      Render video (mp4/webm/gif)"
    echo "  still <dir> [comp] [out]       Render single frame"
    echo "  preview <dir>                  Start dev server"
    echo "  list <dir>                     List compositions"
    echo "  upgrade <dir>                  Upgrade Remotion"
    ;;
esac