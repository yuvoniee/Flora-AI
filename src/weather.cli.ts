/**
 * Module D — Weather Standalone CLI Runner
 *
 * Runs `getWeather()` directly from the command line without launching Tauri or Vite.
 *
 * Usage:
 *   npx tsx src/weather.cli.ts
 */

import { getWeather, getWeatherCacheState } from './weather';

async function runCli() {
  console.log('=== Flora Weather Integration (Module D Standalone CLI) ===\n');
  console.log('Fetching current weather from Open-Meteo...');

  const startTime = Date.now();
  const weather = await getWeather();
  const durationMs = Date.now() - startTime;

  if (weather) {
    console.log('\n✅ Weather fetch successful:');
    console.log(`   Temperature : ${weather.temp}°C`);
    console.log(`   Condition   : ${weather.condition} (WMO Code ${weather.code})`);
    console.log(`   Updated At  : ${weather.updatedAt}`);
    console.log(`   Latency     : ${durationMs}ms`);
    console.log(`   Cache State : ${JSON.stringify(getWeatherCacheState())}`);
  } else {
    console.log('\n⚠️ Weather fetch returned null (fallback active). Check internet connection.');
  }

  console.log('\n--- Testing cache hit ---');
  const cachedWeather = await getWeather();
  if (cachedWeather) {
    console.log(`   Cached Temp : ${cachedWeather.temp}°C (${cachedWeather.condition})`);
    console.log(`   Cache State : ${JSON.stringify(getWeatherCacheState())}`);
  }
}

runCli().catch((err) => {
  console.error('Unexpected CLI error:', err);
  process.exit(1);
});
