const ALPHA_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";

const FUTURES_BASE = "https://fapi.binance.com";
const QUOTE = "USDT";
const AUTO_REFRESH_MINUTES = 5;

function normalizeSymbol(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\/USDT$/, "")
    .replace(/USDT$/, "");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }
  return response.json();
}

async function fetchAlphaTokenList() {
  const json = await getJson(ALPHA_LIST_URL);
  if (json.code !== "000000" || !Array.isArray(json.data)) {
    throw new Error("Binance Alpha 返回格式异常");
  }
  return json.data;
}

function buildAlphaIndex(tokens) {
  const bySymbol = new Map();

  for (const token of tokens) {
    const symbol = normalizeSymbol(token.symbol);

    if (symbol && !bySymbol.has(symbol)) {
      bySymbol.set(symbol, token);
    }
  }

  return { bySymbol };
}

async function fetchFuturesData(symbol) {
  const pair = `${symbol}${QUOTE}`;
  const [ticker, openInterest, premium] = await Promise.all([
    getJson(`${FUTURES_BASE}/fapi/v1/ticker/24hr?symbol=${pair}`),
    getJson(`${FUTURES_BASE}/fapi/v1/openInterest?symbol=${pair}`),
    getJson(`${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${pair}`)
  ]);

  return {
    pair,
    futuresOpenInterest: Number(openInterest.openInterest),
    futuresVolume: Number(ticker.quoteVolume),
    fundingRate: Number(premium.lastFundingRate)
  };
}

async function getField(table, name) {
  try {
    return await table.getFieldByName(name);
  } catch (error) {
    throw new Error(`缺少字段：${name}`);
  }
}

async function setCell(table, field, recordId, value) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    await table.setCellValue(field.id, recordId, null);
    return;
  }
  await table.setCellValue(field.id, recordId, value);
}

async function setText(table, field, recordId, value) {
  await table.setCellValue(field.id, recordId, String(value || ""));
}

async function loadFields(table) {
  return {
    coin: await getField(table, "币种"),
    price: await getField(table, "币价"),
    change24h: await getField(table, "24h"),
    marketCap: await getField(table, "流通市值"),
    fdv: await getField(table, "总市值"),
    alphaVolume: await getField(table, "Alpha成交量"),
    futuresOpenInterest: await getField(table, "合约持仓量"),
    futuresVolume: await getField(table, "合约成交量"),
    fundingRate: await getField(table, "资金费率"),
    updatedAt: await getField(table, "更新时间"),
    status: await getField(table, "状态")
  };
}

async function refreshRecord(table, fields, alphaIndex, recordId) {
  const rawCoin = await table.getCellString(fields.coin.id, recordId);
  const symbol = normalizeSymbol(rawCoin);

  if (!symbol) {
    return;
  }

  const alphaToken = alphaIndex.bySymbol.get(symbol);
  const messages = [];

  if (!alphaToken) {
    await setCell(table, fields.price, recordId, null);
    await setCell(table, fields.change24h, recordId, null);
    await setCell(table, fields.marketCap, recordId, null);
    await setCell(table, fields.fdv, recordId, null);
    await setCell(table, fields.alphaVolume, recordId, null);
    await setCell(table, fields.futuresOpenInterest, recordId, null);
    await setCell(table, fields.futuresVolume, recordId, null);
    await setCell(table, fields.fundingRate, recordId, null);
    await setCell(table, fields.updatedAt, recordId, Date.now());
    await setText(table, fields.status, recordId, "Binance Alpha未找到该币");
    return;
  }

  const alphaSymbol = normalizeSymbol(alphaToken.symbol);

  await setCell(table, fields.price, recordId, Number(alphaToken.price));
  await setCell(table, fields.change24h, recordId, Number(alphaToken.percentChange24h) / 100);
  await setCell(table, fields.marketCap, recordId, Number(alphaToken.marketCap));
  await setCell(table, fields.fdv, recordId, Number(alphaToken.fdv));
  await setCell(table, fields.alphaVolume, recordId, Number(alphaToken.volume24h));
  messages.push(`Alpha已更新：${alphaToken.symbol}`);

  try {
    const futures = await fetchFuturesData(alphaSymbol);
    await setCell(table, fields.futuresOpenInterest, recordId, futures.futuresOpenInterest);
    await setCell(table, fields.futuresVolume, recordId, futures.futuresVolume);
    await setCell(table, fields.fundingRate, recordId, futures.fundingRate);
    messages.push(`合约已更新：${futures.pair}`);
  } catch (error) {
    await setCell(table, fields.futuresOpenInterest, recordId, null);
    await setCell(table, fields.futuresVolume, recordId, null);
    await setCell(table, fields.fundingRate, recordId, null);
    messages.push("无Binance U本位合约数据");
  }

  await setCell(table, fields.updatedAt, recordId, Date.now());
  await setText(table, fields.status, recordId, messages.join("；"));
}

async function refreshTable(table, fields) {
  const tokens = await fetchAlphaTokenList();
  const alphaIndex = buildAlphaIndex(tokens);
  const recordIds = await table.getRecordIdList();

  for (const recordId of recordIds) {
    await refreshRecord(table, fields, alphaIndex, recordId);
  }
}

const table = await bitable.base.getActiveTable();
const fields = await loadFields(table);

await refreshTable(table, fields);

let refreshing = false;
setInterval(async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    await refreshTable(table, fields);
  } finally {
    refreshing = false;
  }
}, AUTO_REFRESH_MINUTES * 60 * 1000);

table.onRecordModify(async event => {
  if (!event.fieldIds.includes(fields.coin.id)) return;
  if (refreshing) return;

  refreshing = true;
  try {
    const tokens = await fetchAlphaTokenList();
    const alphaIndex = buildAlphaIndex(tokens);
    await refreshRecord(table, fields, alphaIndex, event.recordId);
  } finally {
    refreshing = false;
  }
});

console.log("Binance Alpha资产清单脚本已启动");
