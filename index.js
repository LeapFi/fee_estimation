require('dotenv').config();
require('crypto');
const { readFileSync } = require('fs');
const { Web3 } = require("web3");
const providerURL = `https://arb-mainnet.g.alchemy.com/v2/${process.env.alchemyid}`;
// In arbitrum mainnet

const poolAddress = "0xc31e54c7a869b9fcbecc14363cf510d1c41fa443";
const pool_interface = JSON.parse(readFileSync('./IUniswapV3Pool.sol.json', 'utf8')).abi;
const web3 = new Web3(new Web3.providers.HttpProvider(providerURL));
const contract = new web3.eth.Contract(pool_interface,poolAddress);

// 1. calculate average gas cost of the mint action 
const getEvents = async () => {
  const fromBlock = 119567200;
  const toBlock = web3.eth.getBlockNumber();
  const events = await contract.getPastEvents("Mint", {
    fromBlock: fromBlock,
    toBlock: 'latest',
    address: poolAddress,
    limit: 100,
  })
  const transactionHashes = events.map(event => event.transactionHash);
  const transactions = await Promise.all(
    transactionHashes.map(hash => web3.eth.getTransaction(hash))
  );
  const gasUsed = transactions.map(tx => Number(tx.gasPrice * tx.gas)/1e18);
  const totalGasUsed = gasUsed.reduce((a, b) => a + b, 0);
  const averageGasUsed = totalGasUsed / gasUsed.length;
  console.log(averageGasUsed);
}


getEvents();
