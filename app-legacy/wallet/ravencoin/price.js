/**
 * price.js - RVN Price Discovery
 * 
 * Fetches live RVN/USD price for service fee conversion.
 * Uses CoinGecko free API with fallback.
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const https = require('https');

// CoinGecko free API (rate limited but fine for desktop app)
const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price?ids=ravencoin&vs_currencies=usd';

// Fallback price if API unavailable (~$0.03 as of early 2026)
const FALLBACK_PRICE_USD = 0.03;

// Cache price for 5 minutes to avoid hammering API
let cachedPrice = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

class PriceManager {
  /**
   * Get current RVN price in USD.
   * Uses cache to avoid excessive API calls.
   * 
   * @returns {Promise<number>} Price in USD per RVN
   */
  static async getRvnPrice() {
    // Return cached if fresh
    if (cachedPrice && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
      return cachedPrice;
    }

    return new Promise((resolve) => {
      const req = https.get(COINGECKO_API, { timeout: 5000 }, (res) => {
        let data = '';
        
        res.on('data', chunk => data += chunk);
        
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ravencoin?.usd && json.ravencoin.usd > 0) {
              cachedPrice = json.ravencoin.usd;
              cacheTimestamp = Date.now();
              console.log(`[PRICE] RVN/USD: $${cachedPrice}`);
              resolve(cachedPrice);
            } else {
              console.warn('[PRICE] Invalid API response, using fallback');
              resolve(FALLBACK_PRICE_USD);
            }
          } catch (e) {
            console.warn('[PRICE] Parse error, using fallback:', e.message);
            resolve(FALLBACK_PRICE_USD);
          }
        });
      });

      req.on('error', (e) => {
        console.warn('[PRICE] API error, using fallback:', e.message);
        resolve(FALLBACK_PRICE_USD);
      });

      req.on('timeout', () => {
        console.warn('[PRICE] API timeout, using fallback');
        req.destroy();
        resolve(FALLBACK_PRICE_USD);
      });

      req.end();
    });
  }

  /**
   * Calculate RVN amount for a USD target.
   * 
   * @param {number} usdAmount - Target USD amount
   * @returns {Promise<Object>} { usdAmount, exchangeRate, rvnAmount }
   */
  static async usdToRvn(usdAmount) {
    const price = await this.getRvnPrice();
    
    // Calculate RVN needed, round up to 8 decimal places
    const rvnAmount = Math.ceil((usdAmount / price) * 100000000) / 100000000;
    
    return {
      usdAmount,
      exchangeRate: price,
      rvnAmount
    };
  }

  /**
   * Get a fee quote for the service fee.
   * 
   * @param {number} serviceFeeUsd - Service fee in USD
   * @returns {Promise<Object>} Quote with breakdown
   */
  static async getFeeQuote(serviceFeeUsd) {
    const conversion = await this.usdToRvn(serviceFeeUsd);
    
    return {
      serviceFeeUsd,
      serviceFeeRvn: conversion.rvnAmount,
      networkBurnRvn: 500,  // Fixed RVN network cost for root asset
      totalRvn: conversion.rvnAmount + 500,
      exchangeRate: conversion.exchangeRate,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Clear the price cache (for testing or forced refresh).
   */
  static clearCache() {
    cachedPrice = null;
    cacheTimestamp = 0;
  }
}

module.exports = { PriceManager, FALLBACK_PRICE_USD };
