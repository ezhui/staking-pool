import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { StakingPool } from "../target/types/staking_pool";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    Account,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { min } from "bn.js";
import { assert, expect } from "chai";
import { publicKey } from "@coral-xyz/anchor/dist/cjs/utils";

function getProviderAndProgram() {
    const provider = anchor.AnchorProvider.local();
    anchor.setProvider(anchor.AnchorProvider.env());
    const program = anchor.workspace.StakingPool as Program<StakingPool>;

    return { provider, program };
}

async function airdropSol(
    provider: anchor.AnchorProvider,
    receiver: anchor.web3.PublicKey,
    lamports: number
) {
    // Airdropping tokens to a receipt.
    await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(receiver, lamports),
        "confirmed"
    );
}

describe("Test staking-pool", () => {
    const { program, provider } = getProviderAndProgram();
    const connection = provider.connection;

    const authority = provider.wallet as anchor.Wallet;

    let pool: Keypair;
    let mint: Keypair;
    let vault: Account;
    let programSigner: PublicKey;
    let nonce: number;

    let alice: Keypair;
    let bob: Keypair;

    async function initialize() {
        await program.methods
            .initialize(nonce)
            .accounts({
                pool: pool.publicKey,
                mint: mint.publicKey,
                programSigner,
                vault: vault.address,
                authority: authority.publicKey,
            })
            .preInstructions([
                await program.account.pool.createInstruction(pool),
            ])
            .signers([authority.payer, pool])
            .rpc();
    }

    async function airdrop(user: Keypair, amount: number): Promise<PublicKey> {
        let userMintAcc = await getOrCreateAssociatedTokenAccount(
            connection,
            user,
            mint.publicKey,
            user.publicKey
        );

        await program.methods
            .airdrop(new BN(amount))
            .accounts({
                pool: pool.publicKey,
                mint: mint.publicKey,
                programSigner,
                userMintAcc: userMintAcc.address,
                authority: user.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        return userMintAcc.address;
    }

    async function initialize_user_state(user: Keypair): Promise<PublicKey> {
        const [userState] = PublicKey.findProgramAddressSync(
            [pool.publicKey.toBuffer(), user.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .initializeUserState()
            .accounts({
                userState,
                pool: pool.publicKey,
                authority: user.publicKey,
            })
            .signers([user])
            .rpc();

        return userState;
    }

    async function enter_staking(
        user: Keypair,
        amount: number
    ): Promise<PublicKey> {
        let userMintAcc = await getOrCreateAssociatedTokenAccount(
            connection,
            user,
            mint.publicKey,
            user.publicKey
        );

        const [userState] = PublicKey.findProgramAddressSync(
            [pool.publicKey.toBuffer(), user.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .enterStaking(new BN(amount))
            .accounts({
                pool: pool.publicKey,
                mint: mint.publicKey,
                userMintAcc: userMintAcc.address,
                userState,
                vault: vault.address,
                authority: user.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        return userMintAcc.address;
    }

    async function leave_staking(
        user: Keypair,
        amount: number
    ): Promise<PublicKey> {
        let userMintAcc = await getOrCreateAssociatedTokenAccount(
            connection,
            user,
            mint.publicKey,
            user.publicKey
        );

        const [userState] = PublicKey.findProgramAddressSync(
            [pool.publicKey.toBuffer(), user.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .leaveStaking(new BN(amount))
            .accounts({
                pool: pool.publicKey,
                mint: mint.publicKey,
                programSigner,
                userMintAcc: userMintAcc.address,
                userState,
                vault: vault.address,
                authority: user.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

        return userMintAcc.address;
    }

    async function getMintBalanceOf(user: Keypair): Promise<BN> {
        let userMintAcc = await getOrCreateAssociatedTokenAccount(
            connection,
            user,
            mint.publicKey,
            user.publicKey
        );

        const mintBalance = (
            await program.provider.connection.getTokenAccountBalance(
                userMintAcc.address
            )
        ).value.amount;

        return new BN(mintBalance);
    }

    async function get_staked_total(): Promise<BN> {
        const poolContent = await program.account.pool.fetch(pool.publicKey);
        return poolContent.stakedTotal;
    }

    async function get_user_staked(user: Keypair): Promise<BN> {
        const [userState] = PublicKey.findProgramAddressSync(
            [pool.publicKey.toBuffer(), user.publicKey.toBuffer()],
            program.programId
        );

        const us = await program.account.userState.fetch(userState);
        expect(us.initialized).eq(true);
        return us.stakedAmount;
    }

    beforeEach(async () => {
        pool = Keypair.generate();
        mint = Keypair.generate();
        alice = Keypair.generate();
        bob = Keypair.generate();

        await airdropSol(provider, alice.publicKey, 100_000_000_000);
        await airdropSol(provider, bob.publicKey, 100_000_000_000);

        [programSigner, nonce] = PublicKey.findProgramAddressSync(
            [mint.publicKey.toBuffer(), pool.publicKey.toBuffer()],
            program.programId
        );

        await createMint(
            connection,
            authority.payer,
            programSigner,
            authority.publicKey,
            6,
            mint
        );

        vault = await getOrCreateAssociatedTokenAccount(
            connection,
            authority.payer,
            mint.publicKey,
            programSigner,
            true
        );
    });

    it("Initialize", async () => {
        await initialize();
        const poolContent = await program.account.pool.fetch(pool.publicKey);

        expect(poolContent.magic.toNumber()).eq(0x6666);
        expect(poolContent.mint.toString()).eq(mint.publicKey.toString());
        expect(poolContent.vault.toString()).eq(vault.address.toString());
        expect(poolContent.programSigner.toString()).eq(
            programSigner.toString()
        );
        expect(poolContent.nonce).eq(nonce);
    });

    it("Airdrop", async () => {
        await initialize();

        await airdrop(alice, 10_000_000);
        const aliceMintBalance = await getMintBalanceOf(alice);
        expect(aliceMintBalance.toNumber()).eq(10_000_000);

        await airdrop(bob, 30_000_000);
        const bobMintBalance = await getMintBalanceOf(bob);
        expect(bobMintBalance.toNumber()).eq(30_000_000);
    });

    it("Initialize user state", async () => {
        await initialize();

        await initialize_user_state(alice);

        let alice_staked = await get_user_staked(alice);
        expect(alice_staked.toNumber()).eq(0);
    });

    it("Enter staking", async () => {
        await initialize();
        await initialize_user_state(alice);
        await airdrop(alice, 10_000_000);

        await initialize_user_state(bob);
        await airdrop(bob, 30_000_000);

        // Alice staking
        await enter_staking(alice, 10_000_000);
        const aliceMintBalance = await getMintBalanceOf(alice);
        expect(aliceMintBalance.toNumber()).eq(0);

        let total = await get_staked_total();
        expect(total.toNumber()).eq(10_000_000);

        let alice_staked = await get_user_staked(alice);
        expect(alice_staked.toNumber()).eq(10_000_000);

        // bob staking
        await enter_staking(bob, 30_000_000);
        const bobMintBalance = await getMintBalanceOf(bob);
        expect(bobMintBalance.toNumber()).eq(0);

        total = await get_staked_total();
        expect(total.toNumber()).eq(40_000_000);

        let bob_staked = await get_user_staked(bob);
        expect(bob_staked.toNumber()).eq(30_000_000);
    });

    it("Enter staking zero amount", async () => {
        await initialize();
        await initialize_user_state(alice);
        await airdrop(alice, 10_000_000);

        // Alice staking zero
        try {
            await enter_staking(alice, 0);
            assert(false);
        } catch (error) {
            // console.log(error);
        }

        const aliceMintBalance = await getMintBalanceOf(alice);
        expect(aliceMintBalance.toNumber()).eq(10_000_000);

        let total = await get_staked_total();
        expect(total.toNumber()).eq(0);

        let alice_staked = await get_user_staked(alice);
        expect(alice_staked.toNumber()).eq(0);
    });

    it("Leave staking", async () => {
        await initialize();
        await initialize_user_state(alice);
        await airdrop(alice, 10_000_000);

        await initialize_user_state(bob);
        await airdrop(bob, 30_000_000);

        // Alice & bob staking
        await enter_staking(alice, 10_000_000);
        await enter_staking(bob, 30_000_000);

        let total = await get_staked_total();
        expect(total.toNumber()).eq(40_000_000);

        // Alice leave staking
        await leave_staking(alice, 10_000_000);
        total = await get_staked_total();
        expect(total.toNumber()).eq(30_000_000);

        const aliceMintBalance = await getMintBalanceOf(alice);
        expect(aliceMintBalance.toNumber()).eq(10_000_000);

        let alice_staked = await get_user_staked(alice);
        expect(alice_staked.toNumber()).eq(0);

        // Bob leave staking
        await leave_staking(bob, 30_000_000);
        total = await get_staked_total();
        expect(total.toNumber()).eq(0);

        const bobMintBalance = await getMintBalanceOf(bob);
        expect(bobMintBalance.toNumber()).eq(30_000_000);

        let bob_staked = await get_user_staked(bob);
        expect(bob_staked.toNumber()).eq(0);
    });

    it("Leave staking partially", async () => {
        await initialize();
        await initialize_user_state(alice);
        await airdrop(alice, 10_000_000);

        await initialize_user_state(bob);
        await airdrop(bob, 30_000_000);

        // Alice & bob staking
        await enter_staking(alice, 10_000_000);
        await enter_staking(bob, 30_000_000);

        let total = await get_staked_total();
        expect(total.toNumber()).eq(40_000_000);

        // Alice leave staking
        await leave_staking(alice, 5_000_000);
        total = await get_staked_total();
        expect(total.toNumber()).eq(35_000_000);

        const aliceMintBalance = await getMintBalanceOf(alice);
        expect(aliceMintBalance.toNumber()).eq(5_000_000);

        let alice_staked = await get_user_staked(alice);
        expect(alice_staked.toNumber()).eq(5_000_000);

        // Bob leave staking
        await leave_staking(bob, 15_000_000);
        total = await get_staked_total();
        expect(total.toNumber()).eq(20_000_000);

        const bobMintBalance = await getMintBalanceOf(bob);
        expect(bobMintBalance.toNumber()).eq(15_000_000);

        let bob_staked = await get_user_staked(bob);
        expect(bob_staked.toNumber()).eq(15_000_000);
    });

    it("Leave staking invalid amount", async () => {
        await initialize();
        await initialize_user_state(alice);
        await airdrop(alice, 10_000_000);

        // Alice staking
        await enter_staking(alice, 10_000_000);

        try {
            await leave_staking(alice, 10_000_001);
            assert(false);
        } catch (error) {
            // console.log(error);
        }

        const aliceMintBalance = await getMintBalanceOf(alice);
        expect(aliceMintBalance.toNumber()).eq(0);

        let total = await get_staked_total();
        expect(total.toNumber()).eq(10_000_000);

        let alice_staked = await get_user_staked(alice);
        expect(alice_staked.toNumber()).eq(10_000_000);
    });
});
