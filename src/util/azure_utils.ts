import {ethers} from 'ethers';
import {KeyClient, CryptographyClient, SignResult} from '@azure/keyvault-keys';
import {ClientSecretCredential} from '@azure/identity';
import {BN} from 'bn.js';
import {AzureKeyVaultCredentials} from '../index';

/**
 * Constructs public key from azure key-vault JWK
 * @param {AzureKeyVaultCredentials} keyVaultCredentials
 */
export async function getPublicKey(keyVaultCredentials:
  AzureKeyVaultCredentials) {
  const credentials = new ClientSecretCredential(
      keyVaultCredentials.tenantId, keyVaultCredentials.clientId,
      keyVaultCredentials.clientSecret);
  const keyVaultUrl = `https://${keyVaultCredentials.vaultName}.vault.azure.net`;
  const client = new KeyClient(keyVaultUrl, credentials);

  const keyObject = await client.getKey(keyVaultCredentials.keyName);
  const publicKey = Buffer.concat([Uint8Array.from([4]),
    keyObject.key.x, keyObject.key.y]);

  return publicKey;
}

/**
 * Returns ethereum address for a SECP-256K1 public key
 * @param {Buffer} publicKey
 * @return {string}
 */
export async function getEthereumAddress(publicKey: Buffer): Promise<string> {
  const publicKeyWithoutPrefix = publicKey.slice(1, publicKey.length);

  const address = ethers.utils.keccak256(publicKeyWithoutPrefix);
  const ethereumAddress = `0x${address.slice(-40)}`;
  return Promise.resolve(ethereumAddress);
}

/**
 * Signs a digest buffer with an azure key-vault SECP-256K1 key
 * using ES256K algorithm
 * @param {Buffer} digest
 * @param {AzureKeyVaultCredentials} keyVaultCredentials
 * @return {SignResult}
 */
export async function sign(digest: Buffer,
    keyVaultCredentials: AzureKeyVaultCredentials): Promise<SignResult> {
  const credentials = new ClientSecretCredential(
      keyVaultCredentials.tenantId, keyVaultCredentials.clientId,
      keyVaultCredentials.clientSecret);

  try {
    const keyVaultUrl = `https://${keyVaultCredentials.vaultName}.vault.azure.net`;
    const client = new KeyClient(keyVaultUrl, credentials);
    const keyObject = await client.getKey(keyVaultCredentials.keyName);
    const cryptographyClient = new CryptographyClient(keyObject, credentials);

    const signedDigest = await cryptographyClient.sign('ES256K', digest);
    return signedDigest;
  } catch (err) {
    throw new Error(err);
  }
}

/**
 * Recovers public key from an ECDSA signature
 * @param {Buffer} msg
 * @param {BN} r
 * @param {BN} s
 * @param {number} v
 * @return {any}
 */
function recoverPubKeyFromSig(msg: Buffer, r: BN, s: BN, v: number) {
  return ethers.utils.recoverAddress(`0x${msg.toString('hex')}`, {
    r: `0x${r.toString('hex')}`,
    s: `0x${s.toString('hex')}`,
    v,
  });
}

/**
 * Determines the correct recovery identifier 'v' from an ECSDA signature
 * @param {Buffer} msg
 * @param {BN} r
 * @param {BN} s
 * @param {string} expectedEthAddr
 * @return {any}
 */
export function determineCorrectV(
    msg: Buffer, r: BN, s: BN, expectedEthAddr: string) {
  // This is the wrapper function to find the right v value
  // There are two matching signatues on the elliptic curve
  // we need to find the one that matches to our public key
  // it can be v = 27 or v = 28
  let v = 27;
  let pubKey = recoverPubKeyFromSig(msg, r, s, v);
  if (pubKey.toLowerCase() !== expectedEthAddr.toLowerCase()) {
    // if the pub key for v = 27 does not match
    // it has to be v = 28
    v = 28;
    pubKey = recoverPubKeyFromSig(msg, r, s, v);
  }
  return {pubKey, v};
}

/**
 * Calculates r and s values of an ECDSA signature
 * @param {Buffer} signature
 * @return {any}
 */
export function findEthereumSig(signature: Buffer) {
  const r = new BN(signature.slice(0, 32));
  const s = new BN(signature.slice(32, 64));

  const secp256k1N = new BN(
      'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
      16); // max value on the curve
  const secp256k1halfN = secp256k1N.div(new BN(2)); // half of the curve
  // Because of EIP-2 not all elliptic curve signatures are accepted
  // the value of s needs to be SMALLER than half of the curve
  // i.e. we need to flip s if it's greater than half of the curve
  // if s is less than half of the curve,
  // we're on the "good" side of the curve, we can just return
  return {r, s: s.gt(secp256k1halfN) ? secp256k1N.sub(s) : s};
}

/**
 * Requests an Azure Key Vault signature for message buffer
 * @param {Buffer} plaintext
 * @param {AzureKeyVaultCredentials} keyVaultCredentials
 * @return {any}
 */
export async function requestAKVSignature(
    plaintext: Buffer, keyVaultCredentials: AzureKeyVaultCredentials) {
  try {
    const signResult = await sign(plaintext, keyVaultCredentials);

    if (!signResult.result) {
      throw new Error('Azure Key Vault Signed result empty');
    }
    return findEthereumSig(Buffer.from(signResult.result));
  } catch (err) {
    throw new Error(err);
  }
}
