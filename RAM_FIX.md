# Quick Fix for Chrome RAM Limit Issue

The Chrome extension tried to allocate 4GB but Chrome can't handle that much in a single ArrayBuffer.

## Fix: Just reload with 1GB

1. **Go back to setup** (close current tab, click extension icon → Settings)
2. **Set RAM slider to 1 GB** (minimum)
3. **Complete setup again**
4. Should work now!

## Why?

Chrome has memory limits:
- **Max per process**: ~2GB
- **Safe limit**: 1-2GB
- **Desktop app**: Can use 32GB+ (no limits)

## For Higher Mining Power

Use the desktop miner instead of Chrome extension for:
- More RAM (4GB, 8GB, 16GB+)
- Better performance
- Higher rewards

The Chrome extension is great for testing and light mining, but desktop is for serious mining!

---

**Quick command to reload extension:**

1. Go to `chrome://extensions/`
2. Click reload button on REM Miner
3. Click extension icon → Settings
4. Use **1 GB** this time
5. Enter wallet address
6. Start mining ✅
