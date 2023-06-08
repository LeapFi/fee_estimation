
require('dotenv').config();
const ethers = require("ethers");
const axios = require('axios');
const { nearestUsableTick } = require('@uniswap/v3-sdk');
const bn = require("bignumber.js");
const pool_interface = require('./IUniswapV3Pool.sol.json');
const JSBI = require('jsbi');
const q96 = 2**96;

const SupportedChainId = {
  MAINNET : 1,
  GOERLI : 5,
  ARBITRUM_ONE : 42161,
  ARBITRUM_GOERLI : 421613,
  OPTIMISM : 10,
  OPTIMISM_GOERLI : 420,
  POLYGON : 137,
  POLYGON_MUMBAI : 80001,
  CELO : 42220,
  CELO_ALFAJORES : 44787,
  BNB : 56,
}

const NETWORKS = [
  {
    id: "ethereum",
    chainId: SupportedChainId.MAINNET,
    name: "Ethereum",
    desc: "Ethereum Mainnet",
    logoURI:
      "https://seeklogo.com/images/E/ethereum-logo-EC6CDBA45B-seeklogo.com.png",
    subgraphEndpoint:
      "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3",
    totalValueLockedUSD_gte: 1000000,
    volumeUSD_gte: 500000,
  },
  {
    id: "arbitrum",
    chainId: SupportedChainId.ARBITRUM_ONE,
    name: "Arbitrum",
    desc: "Arbitrum Mainnet (L2)",
    disabled: false,
    isNew: false,
    disabledTopPositions: true,
    logoURI:
      "https://assets.website-files.com/5f973c970bea5548ad4287ef/60a320b472858ace6700df76_arb-icon.svg",
    subgraphEndpoint: "https://api.thegraph.com/subgraphs/name/steegecs/uniswap-v3-arbitrum",
    totalValueLockedUSD_gte: 0,
    volumeUSD_gte: 0,
  },
];

const QueryPeriodEnum = {
  ONE_DAY : "1",
  ONE_WEEK : "7",
  ONE_MONTH : "30",
  THREE_MONTH : "90",
  ONE_YEAR : "90",
  MAX : "max",
}

async function getPoolData(poolContract) {
  const [tickSpacing, fee, liquidity, slot0] = await Promise.all([
    poolContract.tickSpacing(),
    poolContract.fee(),
    poolContract.liquidity(),
    poolContract.slot0(),
  ])

  return {
    tickSpacing: tickSpacing,
    fee: fee,
    liquidity: liquidity,
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
  }
}

const getTokenAmountsFromDepositAmounts = (P,Pl,Pu,priceUSDX,priceUSDY,targetAmounts)=>{
    
  let deltaL = targetAmounts / ((Math.sqrt(P) - Math.sqrt(Pl)) * priceUSDY + 
          (1 / Math.sqrt(P) - 1 / Math.sqrt(Pu)) * priceUSDX)

  let deltaY = deltaL * (Math.sqrt(P) - Math.sqrt(Pl))
  if (deltaY * priceUSDY < 0)
    deltaY = 0
  if (deltaY * priceUSDY > targetAmounts)
    deltaY = targetAmounts / priceUSDY

  let deltaX = deltaL * (1 / Math.sqrt(P) - 1 / Math.sqrt(Pu))
  if (deltaX * priceUSDX < 0)
    deltaX = 0;
  if (deltaX * priceUSDX > targetAmounts)
    deltaX = targetAmounts / priceUSDX
  
  return {deltaX,deltaY}
}

const calc_liquidityx96 = (low,cur,up,amt0,amt0_dec,amt1,amt1_dec) => {
  const price_to_sqrtp =(p) => Math.sqrt(p) * q96;
  const liquidity0 = (amount, pa, pb)=>{
    if (pa > pb){
      let tmp = pa
      pa = pb
      pb = tmp
    }
    return (amount * (pa * pb) / q96) / (pb - pa)
  }

  const liquidity1 = (amount, pa, pb)=>{
    if (pa > pb){
      let tmp = pa
      pa = pb
      pb = tmp
    }
    return amount * q96 / (pb - pa)
  }
  let decimal = 10**(amt0_dec-amt1_dec); 
  let amount_0 = amt0 * decimal;
  let amount_1 = amt1 * decimal;
  let sqrtp_low = price_to_sqrtp(low);
  let sqrtp_cur = price_to_sqrtp(cur);
  let sqrtp_upp = price_to_sqrtp(up);
  let liq0 = liquidity0(amount_0, sqrtp_cur, sqrtp_upp);
  let liq1 = liquidity1(amount_1, sqrtp_cur, sqrtp_low);
  let liq = JSBI.BigInt(  parseInt(Math.min(liq0, liq1)) );
  return liq;
}

const _getPoolTicksByPage = async (
  currentNetwork,
  poolAddress,
  tickLower,
  tickUpper,
) => {
  let query = ``;
  if(Math.abs(tickLower)>0){
    query = `{
      ticks(first: 1000, where: { pool: "${poolAddress}" index_gte: "${tickLower}" index_lte: "${tickUpper}" }, orderBy: liquidityGross) {
        index
        liquidityGross
        prices
      }
    }`;
  }
  //console.log(query);
  const { data } = await axios({
    url: currentNetwork.subgraphEndpoint,
    method: "post",
    data: {
      query,
    },
  });
  return data.data.ticks;
};

const getPoolTicks = async (
  currentNetwork,
  poolAddress,
  tickLower,
  tickUpper
) => {
  const PAGE_SIZE = 3;
  let result = [];
  
  const [pool1] = await Promise.all([
    _getPoolTicksByPage(currentNetwork, poolAddress, tickLower, tickUpper),
  ]);
  result = [...result, ...pool1];
  return result;
};

const initPair = async (
  currentNetwork,
  pool,
  coin,
  tickLower,
  tickUpper,
  token0,
  token1,
  token0Decimals,
  token1Decimals
) => {
  const [poolTicks, token0PriceChart,volume24H] =
    await Promise.all([
      getPoolTicks(currentNetwork, pool, tickLower, tickUpper),
      getPriceChart(token0,coin),
      getAvgTradingVolume(currentNetwork, pool),
    ]);

    let _poolTicks = poolTicks;
    if (poolTicks.length === 0) {
      const price0 = Number.MAX_SAFE_INTEGER;
      const price1 = 1 / Number.MAX_SAFE_INTEGER;
      const minTick = getTickFromPrice(
        price0,
        token0Decimals,
        token1Decimals
      );
      const maxTick = getTickFromPrice(
        price1,
        token0Decimals,
        token1Decimals
      );
      _poolTicks = [
        {
          tickIdx: String(minTick),
          price0: String(price0),
          price1: String(price1),
          liquidityNet: pool.liquidity,
        },
        {
          tickIdx: String(maxTick),
          price0: String(price1),
          price1: String(price0),
          liquidityNet: "-" + pool.liquidity,
        },
      ];
    }
  return { poolTicks: _poolTicks, token0PriceChart, volume24H };
}

const getPriceChart = async (
  token,
  coin,
  queryPeriod = QueryPeriodEnum.ONE_MONTH
)=> {
  if (!token) return null;

  const marketChartRes = (await axios.get(
    `https://api.coingecko.com/api/v3/coins/${mktMap_coingek[coin]}/market_chart?vs_currency=usd&days=${queryPeriod}`
  ));

  const prices = marketChartRes.data.prices.map(
    (d) =>
      ({
        timestamp: d[0],
        value: d[1],
      })
  );

  return {
    tokenId: token,
    tokenName: coin,
    currentPriceUSD: prices[prices.length - 1].value,
    prices,
  };
};

const getAvgTradingVolume = async (
  currentNetwork,
  poolAddress,
  numberOfDays = 7,
) => {
  const query = `{
    liquidityPools(where: {id: "${poolAddress}"}) {
      dailySnapshots(skip: 1, first: ${numberOfDays}, orderDirection: desc) {
        dailyTotalVolumeUSD
      }
    }
  }`;
  
  const data = await axios({
    url: currentNetwork.subgraphEndpoint,
    method: "post",
    data: {
      query,
    },
  });

  const volumes = data?.data?.data?.liquidityPools[0].dailySnapshots.map( d => Number(d.dailyTotalVolumeUSD) );
  return volumes.reduce((result, val) => result + val, 0) / volumes.length;
};

const getLiquidityFromTick = (poolTicks) => {
  // calculate a cumulative of liquidityGross from all ticks within poolTicks
  let liquidity = new bn(0);
  for (let i = 0; i < poolTicks.length - 1; ++i) {
    liquidity = liquidity.plus(new bn(poolTicks[i].liquidityGross));
  }
  return liquidity;
};

const aprDataPreparation = async (feeTier='500',tickLower,tickUpper,pool,coin,token0, token1) => {

  // get all data
  const {
    poolTicks,
    token0PriceChart,
    volume24H
  } = await initPair(NETWORKS[1], pool, coin, tickLower, tickUpper, token0, token1,18,6);
  const liquidityGross = getLiquidityFromTick(poolTicks);

  return {
    poolTicks,
    token0PriceChart,
    liquidityGross,
    volume24H
  };
}

const getValues = (
  feeTier=`500`,
  P,
  Pl,
  Pu,
  token0CurrentPriceUSD,
  token1CurrentPriceUSD,
  depositAmountUSD,
  poolTicks,
  currentTick,
  liquidity,
  volume24H,
) => {
  const { deltaX, deltaY } = getTokenAmountsFromDepositAmounts(
    P,Pl,Pu,token0CurrentPriceUSD,token1CurrentPriceUSD,depositAmountUSD);
  
  // calculate liquidity x96 here to compare from chain
  let liquidityDelta = calc_liquidityx96(Pl,P,Pu,deltaX,18,deltaY,6);
  // console.log(`liquidityDeltaX96 ${JSBI.toNumber(liquidityDelta)}`);
  const feeTierPercentage = Number(feeTier) / 10000 / 100;
  const estimateFee =
    P >= Pl && P <= Pu ? getEstimateFee( JSBI.toNumber(liquidityDelta), liquidity, volume24H, feeTierPercentage) : 0;
  
  return {
    estimateFee,
    token0: { amount: deltaX, priceUSD: deltaX * token0CurrentPriceUSD },
    token1: { amount: deltaY, priceUSD: deltaY * 1 },
  }
};

const getEstimateFee = (
  liquidityDelta,
  liquidity,
  avgTradingVolume,
  feeTierPercentage,
) => {
  const liquidityPercentage = liquidityDelta/(liquidity.toNumber()+liquidityDelta);
  return feeTierPercentage * avgTradingVolume * liquidityPercentage;
};

const feeAprEstimation = (
  feeTier,
  currentPrice,
  lower,
  upper,
  depositAmountUSD,
  poolTicks,
  currentTick,
  liquidityGross,
  volume24H
) => {
  // setting
  const P = currentPrice;
  const Pl = lower;
  const Pu = upper;
  //const currentTick = getTickFromPrice(P, token0?.decimals || "18", token1?.decimals || "18");
  const data = getValues(
    feeTier,
    P,
    Pl,
    Pu,
    currentPrice,
    1,
    depositAmountUSD,
    poolTicks,
    currentTick,
    liquidityGross,
    volume24H
  );
  return data;
}

const estimate_apr = async(
    position,
    poolTicks,
    currTick,
    liquidityGross,
    volume24H,
  ) => {
  
  if(poolTicks.length==0){
    return;
  }
  
  let est_res = feeAprEstimation( 
    '500',
    parseFloat(position.entryPrice),
    parseFloat(position.lower),
    parseFloat(position.upper),
    parseFloat(position.amount),
    poolTicks,
    currTick,
    liquidityGross,
    volume24H
  )
  let fee_est = est_res.estimateFee;
  let apy = fee_est*365/position.amount*100.0;
  let dailyincome = apy/365;
  return {apy,dailyincome}
}

// Weth arbitrum address
const WETH_ADDR = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC_ADDR = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
// WETH/USDC 500 fee pool address
const POOL_ADDR_500 = "0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443";
const mktMap_coingek = {
  "ETH/USD":"ethereum",
  "BTC/USD":"bitcoin",
  "LINK/USD":"link",
  "UNI/USD":"uniswap",
}

const main = async () => {
  const token0_decimal = 18; // weth decimal
  const token1_decimal = 6; // usdc decimal
  const decimalDiff = token0_decimal-token1_decimal;
  const base = 1.0001;
  const provider = new ethers.providers.JsonRpcProvider(process.env.RPCURL);
  const pool_contract_main = new ethers.Contract(POOL_ADDR_500, pool_interface.abi , provider);
  let poolData = await getPoolData(pool_contract_main);
  let price = (poolData.sqrtPriceX96 ** 2)/2**192* (10**(token1_decimal*2)); 
  let lower = (price>0)?price*0.98:99999; // set the lower 
  let upper = (price>0)?price*1.02:-99999; // set the upper
  const amount = 1000;  // how much amount usdc you want to provide liquidity
  const position = {
    entryPrice:price,
    lower,
    upper,
    amount
  }

  // can't get the log result of non 2 based so divide by base log
  let tickLower_f = Math.log(lower/(10**decimalDiff)) / Math.log(base);
  let tickLower = nearestUsableTick( parseInt(tickLower_f), poolData.tickSpacing);
  let tickUpper_f = Math.log(upper/(10**decimalDiff)) / Math.log(base);
  let tickUpper = nearestUsableTick(parseInt(tickUpper_f), poolData.tickSpacing);
  let {
    poolTicks,
    token0PriceChart,
    liquidityGross,
    volume24H
  } = await aprDataPreparation('500',tickLower,tickUpper,POOL_ADDR_500,`ETH/USD`,WETH_ADDR,USDC_ADDR);
  let { apy ,dailyincome } = await estimate_apr(
    position,
    poolTicks,
    poolData.tick,
    liquidityGross,
    volume24H
  );
  console.log(`estimated apy is ${apy.toFixed(2)}%, daily fee income is ${dailyincome.toFixed(2)} usd`);
}

main();