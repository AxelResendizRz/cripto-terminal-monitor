// ═══════════════════════════════════════════════════════════════════════════════
// Crypto Price Service — Backend API
// Autor  : Arz.Dev
// Stack  : Node.js · Express · Redis · CoinGecko API
//
// Responsabilidades:
//   1. Polling a CoinGecko cada 20s para obtener precios de mercado
//   2. Persistir historial de precios en Redis (estructura de lista)
//   3. Cachear estadísticas actuales en Redis (estructura de string/JSON)
//   4. Exponer endpoint REST consumido por el frontend en Astro/Vercel
//
// Flujo de datos:
//   CoinGecko API → updatePrices() → Redis → GET /api/prices → Frontend
// ═══════════════════════════════════════════════════════════════════════════════

const express = require("express");
const axios = require("axios");
const redis = require("redis");
const cors = require("cors");

const app = express();
app.use(cors());

// ───────────────────────────────────────────────────────────────────────────────
// Redis Client
//
// Prioridad de conexión:
//   1. REDIS_URL  → cadena completa (Railway, Render, etc.)
//   2. REDIS_HOST → host personalizado con puerto default 6379
//   3. localhost  → entorno local / Docker Compose
// ───────────────────────────────────────────────────────────────────────────────
const redisClient = redis.createClient({
  url:
    process.env.REDIS_URL ||
    `redis://${process.env.REDIS_HOST || "localhost"}:6379`,
});

redisClient.connect().catch(console.error);

// ───────────────────────────────────────────────────────────────────────────────
// Configuración de activos
//
// COINS        : IDs exactos según la API de CoinGecko
// DISPLAY_NAMES: Ticker visible en el frontend (no expuesto por CoinGecko Markets)
// HISTORY_LIMIT: Máximo de snapshots por activo en Redis (ventana deslizante)
//                Con polling de 20s → 30 puntos = ~10 minutos de historial
// ───────────────────────────────────────────────────────────────────────────────
const COINS = [
  "bitcoin",
  "ethereum",
  "solana",
  "cardano",
  "binancecoin",
  "ripple",
];

const DISPLAY_NAMES = {
  bitcoin:     "BTC",
  ethereum:    "ETH",
  solana:      "SOL",
  cardano:     "ADA",
  binancecoin: "BNB",
  ripple:      "XRP",
};

const HISTORY_LIMIT = 30;

// ───────────────────────────────────────────────────────────────────────────────
// updatePrices()
//
// Consulta el endpoint /coins/markets de CoinGecko con todos los activos
// en una sola request (batch), luego persiste en Redis dos estructuras:
//
//   history:<coinId>  →  Lista  (LPUSH + LTRIM)
//     Cada elemento: JSON { price: number, timestamp: ms }
//     LPUSH inserta al frente → el índice 0 siempre es el más reciente
//     LTRIM mantiene la lista acotada a HISTORY_LIMIT elementos
//
//   stats:<coinId>    →  String (SET, sobreescritura total)
//     JSON con el snapshot completo: precio, variación, cap, volumen, high, low
//     Se sobreescribe en cada ciclo — no acumula, solo el estado actual
//
// Nota: esta función es async y se usa tanto en el scheduler (setInterval)
// como en el arranque del servidor (.then(() => app.listen(...)))
// ───────────────────────────────────────────────────────────────────────────────
const updatePrices = async () => {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/coins/markets",
      {
        params: {
          vs_currency: "usd",
          ids: COINS.join(","),
          price_change_percentage: "24h",
        },
      }
    );

    for (const coin of response.data) {
      const { id: coinId, current_price: price } = coin;
      const timestamp = Date.now();

      // Historial — ventana deslizante de HISTORY_LIMIT puntos
      await redisClient.lPush(`history:${coinId}`, JSON.stringify({ price, timestamp }));
      await redisClient.lTrim(`history:${coinId}`, 0, HISTORY_LIMIT - 1);

      // Snapshot actual — sobreescritura en cada ciclo
      await redisClient.set(
        `stats:${coinId}`,
        JSON.stringify({
          usd:          price,
          high_24h:     coin.high_24h,
          low_24h:      coin.low_24h,
          market_cap:   coin.market_cap,
          total_volume: coin.total_volume,
          change_24h:   coin.price_change_percentage_24h,
        })
      );
    }

    console.log(`[${new Date().toLocaleTimeString()}] ✅ Redis actualizado — ${COINS.length} activos`);
  } catch (error) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Error en updatePrices:`, error.message);
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// Scheduler — polling cada 20 segundos
//
// Se registra antes del primer arranque para que el intervalo quede activo
// desde el momento en que el servidor empieza a aceptar conexiones.
// ───────────────────────────────────────────────────────────────────────────────
setInterval(updatePrices, 20_000);

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/prices
//
// Respuesta: Record<coinId, CoinPayload>
//
// CoinPayload {
//   usd          : number   — precio actual en USD
//   name         : string   — ticker display (BTC, ETH, ...)
//   history      : Array<{ x: timestamp_ms, y: price }>  — orden cronológico ASC
//   high_24h     : number
//   low_24h      : number
//   market_cap   : number
//   total_volume : number
//   change_24h   : number   — variación porcentual 24h (real, desde CoinGecko)
// }
//
// Una coin solo se incluye en la respuesta si ya existe su snapshot en Redis
// (stats:<coinId>). El historial puede estar vacío en el primer ciclo — el
// frontend maneja ese caso sin romper la UI.
// ───────────────────────────────────────────────────────────────────────────────
app.get("/api/prices", async (req, res) => {
  try {
    const result = {};

    for (const coin of COINS) {
      // Historial: almacenado con LPUSH (más reciente al frente) → invertir para ASC
      const rawHistory = await redisClient.lRange(`history:${coin}`, 0, -1);
      const history = rawHistory
        .map((entry) => {
          const { price, timestamp } = JSON.parse(entry);
          return { x: Number(timestamp), y: Number(price) };
        })
        .reverse();

      // Stats: puede ser null si el servidor acaba de arrancar y aún no completó
      // el primer updatePrices() — en ese caso se omite la coin del resultado
      const rawStats = await redisClient.get(`stats:${coin}`);
      if (!rawStats) continue;

      const stats = JSON.parse(rawStats);

      result[coin] = {
        usd:          stats.usd,
        name:         DISPLAY_NAMES[coin] || coin.toUpperCase(),
        history,
        high_24h:     stats.high_24h,
        low_24h:      stats.low_24h,
        market_cap:   stats.market_cap,
        total_volume: stats.total_volume,
        change_24h:   stats.change_24h,
      };
    }

    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toLocaleTimeString()}] ❌ Error en GET /api/prices:`, error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Bootstrap
//
// Se ejecuta updatePrices() antes de abrir el puerto para garantizar que Redis
// tenga datos en el primer request. Sin esto, el frontend recibiría un objeto
// vacío {} en el SSR de Astro y mostraría el estado de error.
// ───────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

updatePrices().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
  });
});