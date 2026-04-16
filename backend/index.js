// ─────────────────────────────────────────────────────────────
// 📦 Backend - Crypto Price Service
// Autor: Arz.Dev
// Descripción:
// Servicio encargado de:
// 1. Obtener precios de criptomonedas desde CoinGecko
// 2. Persistir historial en Redis (para gráficas)
// 3. Exponer endpoint REST para consumo del frontend
// ─────────────────────────────────────────────────────────────

const express = require("express");
const axios = require("axios");
const redis = require("redis");
const cors = require("cors");

const app = express();
app.use(cors());

// ─────────────────────────────────────────────────────────────
// 🔌 Configuración de Redis
// Usa variable de entorno para soportar Docker / local
// ─────────────────────────────────────────────────────────────
const redisClient = redis.createClient({
  url:
    process.env.REDIS_URL ||
    `redis://${process.env.REDIS_HOST || "localhost"}:6379`,
});

// Conexión inicial a Redis
redisClient.connect().catch(console.error);

// ─────────────────────────────────────────────────────────────
// ⚙️ Configuración del sistema
// ─────────────────────────────────────────────────────────────
const COINS = ["bitcoin", "ethereum", "solana", "cardano"];
const HISTORY_LIMIT = 30; // Máximo de puntos almacenados por activo

// ─────────────────────────────────────────────────────────────
// 🔄 updatePrices()
// Obtiene precios actuales desde CoinGecko y los guarda en Redis
//
// Estructura en Redis:
// - history:<coin> → Lista (LPUSH) de precios recientes
//
// Cada entrada:
// {
//   price: number,
//   timestamp: number (ms)
// }
// ─────────────────────────────────────────────────────────────
const updatePrices = async () => {
  try {
    const ids = COINS.join(",");

    // Llamada a CoinGecko (datos de mercado)
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/coins/markets`,
      {
        params: {
          vs_currency: "usd",
          ids,
          price_change_percentage: "24h",
        },
      },
    );

    const data = response.data;

    // Iteración sobre cada criptomoneda
    for (const coin of data) {
      const coinId = coin.id;
      const price = coin.current_price;
      const timestamp = Date.now();

      // ── 1. Guardar historial (para la gráfica) ──
      const historyEntry = JSON.stringify({ price, timestamp });
      await redisClient.lPush(`history:${coinId}`, historyEntry);
      await redisClient.lTrim(`history:${coinId}`, 0, HISTORY_LIMIT - 1);

      // ── 2. NUEVO: Guardar estadísticas actuales (PARA LLENAR LOS ESPACIOS VACÍOS) ──
      const stats = {
        usd: price,
        high_24h: coin.high_24h,
        low_24h: coin.low_24h,
        market_cap: coin.market_cap,
        total_volume: coin.total_volume,
        change_24h: coin.price_change_percentage_24h,
      };

      // Guardamos esto como un string simple en Redis con una llave única por moneda
      await redisClient.set(`stats:${coinId}`, JSON.stringify(stats));
    }

    console.log(
      `[${new Date().toLocaleTimeString()}] Redis actualizado (${COINS.length} activos)`,
    );
  } catch (error) {
    console.error("❌ Error actualizando precios:", error.message);
  }
};

// ─────────────────────────────────────────────────────────────
// ⏱️ Scheduler
// Ejecuta la actualización cada 20 segundos
// ─────────────────────────────────────────────────────────────
setInterval(updatePrices, 20000);

// Primera ejecución al iniciar el servidor
updatePrices();

// ─────────────────────────────────────────────────────────────
// 🌐 GET /api/prices
//
// Retorna:
// {
//   bitcoin: {
//     usd: number,
//     history: [{ x: timestamp, y: price }],
//     change_24h: number
//   }
// }
//
// Notas:
// - history se invierte para orden cronológico
// - change_24h es calculado localmente (no es exacto real)
// ─────────────────────────────────────────────────────────────
app.get("/api/prices", async (req, res) => {
  try {
    let result = {};

    for (const coin of COINS) {
      // 1. Obtener historial (para la gráfica)
      const rawHistory = await redisClient.lRange(`history:${coin}`, 0, -1);

      const history = rawHistory
        .map((entry) => {
          const parsed = JSON.parse(entry);
          return { x: Number(parsed.timestamp), y: Number(parsed.price) };
        })
        .reverse();

      // 2. NUEVO: Obtener las estadísticas guardadas por updatePrices
      const rawStats = await redisClient.get(`stats:${coin}`);
      const stats = rawStats ? JSON.parse(rawStats) : null;

      if (history.length > 0) {
        // Usamos los stats de Redis, y si no existen (primer inicio), usamos el último precio del historial
        const latestPrice = stats ? stats.usd : history[history.length - 1].y;

        result[coin] = {
          usd: latestPrice,
          history: history,
          // Pasamos los datos técnicos al frontend
          high_24h: stats ? stats.high_24h : 0,
          low_24h: stats ? stats.low_24h : 0,
          market_cap: stats ? stats.market_cap : 0,
          total_volume: stats ? stats.total_volume : 0,
          // Puedes usar el cambio real de CoinGecko que guardamos en stats
          change_24h: stats ? stats.change_24h : 0,
        };
      }
    }

    res.json(result);
  } catch (error) {
    console.error("❌ Error en /api/prices:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 🚀 Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
