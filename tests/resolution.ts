import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import { Resolution } from "../target/types/resolution";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { BanksClient, Clock, ProgramTestContext } from "solana-bankrun";
import { Keypair, PublicKey, VoteProgram } from "@solana/web3.js";
import * as voteAccount from './vote_account.json';
import { assert, expect } from "chai";

const IDL = require("../target/idl/resolution.json");

async function setClockTimestamp (context: ProgramTestContext, unixTimestamp: number) {
  const currentClock = await context.banksClient.getClock();
    const newUnixTimestamp = BigInt(unixTimestamp);
    const newClock = new Clock(
      currentClock.slot,
      currentClock.epochStartTimestamp,
      currentClock.epoch,
      currentClock.leaderScheduleEpoch,
      newUnixTimestamp
    );
    await context.setClock(newClock);
}

describe("resolution", async () => {
  let provider: BankrunProvider,
    payer: Keypair,
    context: ProgramTestContext,
    banksClient: BanksClient,
    program: Program<Resolution>,
    voteAccountPubkey: PublicKey,
    stakeKeypair: Keypair,
    approverA: Keypair,
    approverB: Keypair,
    approverC: Keypair,
    resolutionPDA: PublicKey;


  before(async function () {
    voteAccountPubkey = new PublicKey(voteAccount.pubkey);
    const voteAccountData = Uint8Array.from(atob(voteAccount.account.data[0]), (c) =>
      c.charCodeAt(0),
    );

    context = await startAnchor("./", [],[
      {
        address: voteAccountPubkey,
        info: {
          lamports: voteAccount.account.lamports,
          data: voteAccountData,
          owner: VoteProgram.programId,
          executable: false,
        },
      },
    ],);
    banksClient = context.banksClient;
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new Program<Resolution>(IDL, provider)
    payer = provider.wallet.payer;
    approverA = new Keypair();
    approverB = new Keypair();
    approverC = new Keypair();
    stakeKeypair = Keypair.generate();
  });

  it("initialize resolution", async () => {
    await program.methods.initializeResolution(new anchor.BN(5_000_000_000), new anchor.BN(365 * 24 * 60 * 60*1000), "Hello World").accounts({
      owner: payer.publicKey,
      stakeAccount: stakeKeypair.publicKey,
      validatorVoteAccount: voteAccountPubkey,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeConfig: new anchor.web3.PublicKey("StakeConfig11111111111111111111111111111111"),
    }).remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverA.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverB.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverC.publicKey,
      },
    ]).signers([stakeKeypair]).rpc();

     [resolutionPDA,] = await PublicKey.findProgramAddressSync([Buffer.from("resolution"), payer.publicKey.toBuffer()], program.programId);
    

    const resolutionAccount = await program.account.resolutionAccount.fetch(resolutionPDA);

    expect(resolutionAccount.owner.toString()).to.equal(payer.publicKey.toString());
    expect(resolutionAccount.text).to.equal("Hello World");
    expect(resolutionAccount.approvers.length).to.equal(3);
    expect(resolutionAccount.approvers[0].toString()).to.equal(approverA.publicKey.toString());
    expect(resolutionAccount.approvers[1].toString()).to.equal(approverB.publicKey.toString());
    expect(resolutionAccount.approvers[2].toString()).to.equal(approverC.publicKey.toString());
    expect(resolutionAccount.numApprovals).to.equal(0);
    expect(resolutionAccount.stakeAmount.toNumber()).to.equal(5_000_000_000);
    expect(resolutionAccount.stakeAccount.toString()).to.equal(stakeKeypair.publicKey.toString());


  });

  it("approve resolution", async () => {
   await program.methods.approveResolution().accountsStrict({
    signer: approverA.publicKey,
    owner: payer.publicKey,
    resolutionAccount: resolutionPDA,
   }).signers([approverA]).rpc();

    const resolutionAccount = await program.account.resolutionAccount.fetch(resolutionPDA);
    expect(resolutionAccount.numApprovals).to.equal(1);
  })

  it("attempt close before approval", async () => {
    try {
      await program.methods.closeResolution().accountsStrict({
        owner: payer.publicKey,
        stakeAccount: stakeKeypair.publicKey,
        resolutionAccount: resolutionPDA,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
      }).signers([payer]).rpc();
      assert.fail("Expected an error to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(AnchorError);
      expect(error.error.errorCode.code).to.equal("LockupInForce");
    }
  })

  it("close resolution after approvals", async () => {
    await program.methods.approveResolution().accountsStrict({
      signer: approverB.publicKey,
      owner: payer.publicKey,
      resolutionAccount: resolutionPDA,
     }).signers([approverB]).rpc();

     await program.methods.approveResolution().accountsStrict({
      signer: approverC.publicKey,
      owner: payer.publicKey,
      resolutionAccount: resolutionPDA,
     
     }).signers([approverC]).rpc();

     // deactivate stake account
     await program.methods.deactivateResolutionStake().accountsStrict({
      owner: payer.publicKey,
      stakeAccount: stakeKeypair.publicKey,
      resolutionAccount: resolutionPDA,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
    }).signers([payer]).rpc();


     await program.methods.closeResolution().accountsStrict({
      owner: payer.publicKey,
      stakeAccount: stakeKeypair.publicKey,
      resolutionAccount: resolutionPDA,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
    }).signers([payer]).rpc();

  })

  it("close resolution after lockup", async () => {
    const [newResolutionPDA,] = await PublicKey.findProgramAddressSync([Buffer.from("resolution"), payer.publicKey.toBuffer()], program.programId);
    const newStakeKeypair = Keypair.generate();

    await program.methods.initializeResolution(new anchor.BN(5_000_000_000), new anchor.BN(365 * 24 * 60 * 60*1000), "New Resolution").accounts({
      owner: payer.publicKey,
      stakeAccount: newStakeKeypair.publicKey,
      validatorVoteAccount: voteAccountPubkey,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeConfig: new anchor.web3.PublicKey("StakeConfig11111111111111111111111111111111"),
    }).remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverA.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverB.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverC.publicKey,
      },
    ]).signers([payer, newStakeKeypair]).rpc();

    await program.methods.deactivateResolutionStake().accountsStrict({
      owner: payer.publicKey,
      stakeAccount: newStakeKeypair.publicKey,
      resolutionAccount: newResolutionPDA,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
    }).signers([payer]).rpc();

    try {
      await program.methods.closeResolution().accountsStrict({
        owner: payer.publicKey,
        stakeAccount: newStakeKeypair.publicKey,
        resolutionAccount: newResolutionPDA,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
        stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
      }).signers([payer]).rpc();
      assert.fail("Expected an error to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(AnchorError);
      expect(error.error.errorCode.code).to.equal("LockupInForce");
    }

    // Add this line to ensure clock update is processed
    context.warpToSlot(BigInt(100000));
    await setClockTimestamp(context, Date.now()  + 365 * 24 * 60 * 60 + 1000);
    // Add small delay to ensure clock update is processed
    await new Promise(resolve => setTimeout(resolve, 100));

    await program.methods.closeResolution().accountsStrict({
      owner: payer.publicKey,
      stakeAccount: newStakeKeypair.publicKey,
      resolutionAccount: newResolutionPDA,
      clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeHistory: anchor.web3.SYSVAR_STAKE_HISTORY_PUBKEY,
    }).signers([payer]).rpc();
  })

  it("duplicate approvers", async () => {
    try {
      const newStakeKeypair = Keypair.generate();

    await program.methods.initializeResolution(new anchor.BN(5_000_000_000), new anchor.BN(365 * 24 * 60 * 60*1000), "New Resolution").accounts({
      owner: payer.publicKey,
      stakeAccount: newStakeKeypair.publicKey,
      validatorVoteAccount: voteAccountPubkey,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeConfig: new anchor.web3.PublicKey("StakeConfig11111111111111111111111111111111"),
    }).remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverA.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverA.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverC.publicKey,
      },
    ]).signers([payer, newStakeKeypair]).rpc();
    assert.fail("Expected an error to be thrown");
    }
    catch (error) {
      expect(error).to.be.instanceOf(AnchorError);
      expect(error.error.errorCode.code).to.equal("InvalidApprover");
    }
  })

  it("self approver", async() => {
    try {
      const newStakeKeypair = Keypair.generate();

    await program.methods.initializeResolution(new anchor.BN(5_000_000_000), new anchor.BN(365 * 24 * 60 * 60*1000), "New Resolution").accounts({
      owner: payer.publicKey,
      stakeAccount: newStakeKeypair.publicKey,
      validatorVoteAccount: voteAccountPubkey,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeConfig: new anchor.web3.PublicKey("StakeConfig11111111111111111111111111111111"),
    }).remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverA.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: payer.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverC.publicKey,
      },
    ]).signers([payer, newStakeKeypair]).rpc();
    assert.fail("Expected an error to be thrown");
    }
    catch (error) {
      expect(error).to.be.instanceOf(AnchorError);
      expect(error.error.errorCode.code).to.equal("InvalidApprover");
    }
  })

  it("invalid number of approvers", async () => {
    try {
      const newStakeKeypair = Keypair.generate();

    await program.methods.initializeResolution(new anchor.BN(5_000_000_000), new anchor.BN(365 * 24 * 60 * 60*1000), "New Resolution").accounts({
      owner: payer.publicKey,
      stakeAccount: newStakeKeypair.publicKey,
      validatorVoteAccount: voteAccountPubkey,
      stakeProgram: new anchor.web3.PublicKey("Stake11111111111111111111111111111111111111"),
      stakeConfig: new anchor.web3.PublicKey("StakeConfig11111111111111111111111111111111"),
    }).remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverA.publicKey,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: approverB.publicKey,
      }
    ]).signers([payer, newStakeKeypair]).rpc();
    assert.fail("Expected an error to be thrown");
    }
    catch (error) {
      expect(error).to.be.instanceOf(AnchorError);
      expect(error.error.errorCode.code).to.equal("InvalidNumApprovers");
    }
  })

});
