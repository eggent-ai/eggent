# Code Execution Tool

Execute code in a specified runtime environment. The code runs on the user's machine.

## Available Runtimes

- **python** — Python 3 interpreter. Use for: data processing, file manipulation, calculations, web scraping, automation scripts.
- **nodejs** — Node.js runtime. Use for: JavaScript/TypeScript tasks, web APIs, JSON processing, npm packages.
- **terminal** — Bash shell. Use for: system commands, file operations, package installation, process management.

## Best Practices

1. **One task per execution** — keep code focused on a single operation
2. **Print outputs explicitly** — always `print()` or `console.log()` results you want to see
3. **Handle errors** — wrap risky operations in try/except or try/catch
4. **Check prerequisites** — verify packages are installed before importing
5. **Use sessions wisely** — session 0 is the default; use different sessions for parallel tasks
6. **Prefer dedicated file tools first** — use `read_text_file`, `read_pdf_file`, `write_text_file`, and `copy_file` for common file tasks; use `code_execution` only when those tools are insufficient
7. **Auto-resolve missing Python deps** — if you see `ModuleNotFoundError`, run `python3 -m pip install <package>` in `terminal`, then rerun Python code
8. **Install system packages with sudo** — use `sudo apt-get update && sudo apt-get install -y <package>`

## Examples

### Install a package then use it
First execution: `python3 -m pip install requests` (runtime: terminal)
Second execution: `import requests; r = requests.get('...'); print(r.json())` (runtime: python)

### Install a system package
Use: `sudo apt-get update && sudo apt-get install -y ffmpeg` (runtime: terminal)

### File operations (fallback)
```python
# Read a file
with open('data.txt', 'r') as f:
    content = f.read()
print(content)
```

### System information
```bash
# runtime: terminal
uname -a && python3 --version && node --version
```

## Limitations

- Execution timeout: configurable (default 180 seconds)
- Output is truncated at configurable max length
- No GUI applications — terminal only
- Network access depends on system configuration
