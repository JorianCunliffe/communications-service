#!/bin/bash
set -e

echo "Installing dependencies..."
npm install --prefer-offline

echo "Applying database migrations..."
node scripts/migrate.js

echo "Post-merge setup complete."
