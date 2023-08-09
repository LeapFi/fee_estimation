require('dotenv').config();
require('crypto');
const { readFileSync } = require('fs');
const { Web3 } = require("web3");
//const providerURL = `https://arb-mainnet.g.alchemy.com/v2/${process.env.alchemyid}`;
const providerURL = `https://arbitrum-mainnet.infura.io/v3/${process.env.infuraid}`;
// In arbitrum mainnet

const poolAddress = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa443";
const pool_interface = JSON.parse(readFileSync('./IUniswapV3Pool.sol.json', 'utf8')).abi;
const web3 = new Web3(new Web3.providers.HttpProvider(providerURL));
const contract = new web3.eth.Contract(pool_interface,poolAddress);
const OneETH = 1e18;
const fromBlock = 119567200;
const toBlock = web3.eth.getBlockNumber();

// 1. calculate average gas cost of the mint action 
const getMintEvents = async () => {
  
  
  const events = await contract.getPastEvents("Mint", {
    fromBlock: fromBlock,
    toBlock: 'latest',
    address: poolAddress,
    limit: 10,
  })
  const transactionHashes = events.map(event => event.transactionHash);
  const transactions = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransaction(hash))
  );
  const receipts = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransactionReceipt(hash))
  )
  
  const gasUsed = transactions.map((tx,index) => Number(tx.gasPrice * receipts[index].gasUsed)/OneETH);
  const totalGasUsed = gasUsed.reduce((a, b) => a + b, 0);
  const averageGasUsed = totalGasUsed / gasUsed.length;
  console.log(`Mint averageGasUsed ${averageGasUsed}`);
  return averageGasUsed;
}


// 2. calculate average gas cost of the swal action 
const getSwapEvents = async () => {
  
  const events = await contract.getPastEvents("Swap", {
    fromBlock: fromBlock,
    toBlock: 'latest',
    address: poolAddress,
    limit: 10,
  })
  const transactionHashes = events.map(event => event.transactionHash);
  const transactions = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransaction(hash))
  );
  const receipts = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransactionReceipt(hash))
  )
  const gasUsed = transactions.map((tx,index) => Number(tx.gasPrice * receipts[index].gasUsed)/OneETH);
  const totalGasUsed = gasUsed.reduce((a, b) => a + b, 0);
  const averageGasUsed = totalGasUsed / gasUsed.length;
  console.log(`Swap averageGasUsed ${averageGasUsed}`);
  return averageGasUsed;
}

// 3. calculate average gas cost of the GMX shor open
const getShortPositionOpenEvents = async () => {
  const routerAddress = "0xb87a436B93fFE9D75c5cFA7bAcFff96430b09868";
  const router_interface = JSON.parse(readFileSync('./IPositionRouter.sol.json', 'utf8')).abi;
  const router_contract = new web3.eth.Contract(router_interface,routerAddress);
  
  const events = await router_contract.getPastEvents("CreateIncreasePosition", {
    fromBlock: fromBlock,
    toBlock: 'latest',
    address: routerAddress,
    limit: 40,
  })
  const transactionHashes = events.map(event => event.transactionHash);
  const transactions = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransaction(hash))
  );
  const receipts = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransactionReceipt(hash))
  )
  const gasUsed = transactions.map((tx,index) => Number(tx.gasPrice * receipts[index].gasUsed)/OneETH);
  const totalGasUsed = gasUsed.reduce((a, b) => a + b, 0);
  const averageGasUsed = totalGasUsed / gasUsed.length;
  console.log(`CreateIncreasePosition averageGasUsed ${averageGasUsed}`);
  return averageGasUsed;

}


const collectEventsGas = async () => {
  const mintAvfGasUsed = await getMintEvents();
  const swapAvfGasUsed = await getSwapEvents();
  const gmxAvgGasUsed = await getShortPositionOpenEvents();
  const totalGasUsed = mintAvfGasUsed + swapAvfGasUsed + gmxAvgGasUsed;
  console.log(`------------------------------------------------------------`);
  console.log(`Total Gas Used (SWAP+MINT+GMX_SHORT) = ${totalGasUsed} eth`);
  console.log(`------------------------------------------------------------`);
  console.log(`######`);
}

collectEventsGas();