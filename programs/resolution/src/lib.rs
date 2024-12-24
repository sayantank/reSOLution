pub mod constants;
pub mod error;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    stake::{
        self,
        instruction::{deactivate_stake, delegate_stake, initialize, withdraw},
        state::StakeStateV2,
        state::{Authorized, Lockup},
    },
    system_instruction::create_account,
    vote::{self},
};

pub use constants::*;
use error::ResolutionErrorCode;

declare_id!("C3YcwAaUtby4vHGvJ9dRUNe4UiPMLVfLp89XZG1vQeFy");

#[program]
pub mod resolution {

    use super::*;

    pub fn initialize_resolution(
        ctx: Context<InitializeResolution>,
        stake_amount: u64,
        lockup_duration: i64,
        text: String,
    ) -> Result<()> {
        let approvers: Vec<Pubkey> = ctx
            .remaining_accounts
            .iter()
            .map(|account| account.key())
            .collect();

        if approvers.len() != 3 {
            return Err(ResolutionErrorCode::InvalidNumApprovers.into());
        }

        // owner shouldn't be in the approvers list
        if approvers.contains(&ctx.accounts.owner.key()) {
            return Err(ResolutionErrorCode::InvalidApprover.into());
        }

        // check if all approvers are unique
        let mut unique_approvers = approvers.clone();
        unique_approvers.sort();
        unique_approvers.dedup();
        if unique_approvers.len() != approvers.len() {
            return Err(ResolutionErrorCode::InvalidApprover.into());
        }

        let now = Clock::get()?.unix_timestamp;
        let lockup_end = now + lockup_duration;

        // Both stake_authority and withdraw_authority are the owner
        let authorized = Authorized {
            staker: ctx.accounts.resolution_account.key(),
            withdrawer: ctx.accounts.owner.key(),
        };

        // Configure Lockup for stake account
        // Set custodian to resolution PDA account
        let lockup = Lockup {
            unix_timestamp: lockup_end,
            epoch: 0,
            custodian: ctx.accounts.resolution_account.key(),
        };

        // Calculate balance for stake account
        let rent = Rent::get()?;
        let stake_space = StakeStateV2::size_of();
        let lamports = rent
            .minimum_balance(stake_space)
            .saturating_add(stake_amount);

        invoke(
            &create_account(
                &ctx.accounts.owner.key,
                &ctx.accounts.stake_account.key,
                lamports,
                stake_space as u64,
                &stake::program::ID,
            ),
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.stake_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Initialize stake account
        invoke(
            &initialize(&ctx.accounts.stake_account.key, &authorized, &lockup),
            &[
                ctx.accounts.stake_account.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
        )?;

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"resolution",
            ctx.accounts.owner.key.as_ref(),
            &[ctx.bumps.resolution_account],
        ]];

        // Delegate stake
        invoke_signed(
            &delegate_stake(
                &ctx.accounts.stake_account.key,
                &ctx.accounts.resolution_account.key(),
                &ctx.accounts.validator_vote_account.key,
            ),
            &[
                ctx.accounts.stake_account.to_account_info(),
                ctx.accounts.validator_vote_account.to_account_info(),
                ctx.accounts.clock.to_account_info(),
                ctx.accounts.stake_history.to_account_info(),
                ctx.accounts.stake_config.to_account_info(),
                ctx.accounts.resolution_account.to_account_info(),
            ],
            signer_seeds,
        )?;

        let resolution = &mut ctx.accounts.resolution_account;

        resolution.owner = ctx.accounts.owner.key();
        resolution.text = text;
        resolution.approvers = approvers;
        resolution.approved_by = [].to_vec();
        resolution.stake_amount = stake_amount;
        resolution.stake_account = ctx.accounts.stake_account.key();
        resolution.start_time = now;
        resolution.end_time = lockup_end;
        resolution.bump = ctx.bumps.resolution_account;

        Ok(())
    }

    pub fn approve_resolution(ctx: Context<ApproveResolution>) -> Result<()> {
        let resolution = &mut ctx.accounts.resolution_account;

        // check if the signer is in the approvers list
        if !resolution.approvers.contains(&ctx.accounts.signer.key()) {
            return Err(ResolutionErrorCode::InvalidApprover.into());
        }

        if resolution.approved_by.contains(&ctx.accounts.signer.key()) {
            return Err(ResolutionErrorCode::AlreadyApproved.into());
        }

        resolution.approved_by.push(ctx.accounts.signer.key());

        Ok(())
    }

    pub fn deactivate_resolution_stake(ctx: Context<DeactivateResolutionStake>) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"resolution",
            ctx.accounts.owner.key.as_ref(),
            &[ctx.bumps.resolution_account],
        ]];

        invoke_signed(
            &deactivate_stake(
                &ctx.accounts.stake_account.key(),
                &ctx.accounts.resolution_account.key(),
            ),
            &[
                ctx.accounts.stake_account.to_account_info(),
                ctx.accounts.clock.to_account_info(),
                ctx.accounts.resolution_account.to_account_info(),
            ],
            signer_seeds,
        )?;

        Ok(())
    }

    pub fn close_resolution(ctx: Context<CloseResolution>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;

        let resolution_key = ctx.accounts.resolution_account.key();
        let resolution = &mut ctx.accounts.resolution_account;

        let is_approved =
            resolution.approved_by.len() >= resolution.approvers.len().try_into().unwrap();

        // If resolution is not yet approved,
        // then it's not possible to close the resolution before the end time
        if !is_approved && now < resolution.end_time {
            return Err(ResolutionErrorCode::LockupInForce.into());
        }

        // Empty the whole stake account
        let withdraw_amount = ctx.accounts.stake_account.lamports();

        match is_approved {
            true => {
                let signer_seeds: &[&[&[u8]]] = &[&[
                    b"resolution",
                    ctx.accounts.owner.key.as_ref(),
                    &[ctx.bumps.resolution_account],
                ]];

                invoke_signed(
                    &withdraw(
                        &ctx.accounts.stake_account.key(),
                        &ctx.accounts.owner.key(),
                        &ctx.accounts.owner.key(),
                        withdraw_amount,
                        Some(&resolution_key),
                    ),
                    &[
                        ctx.accounts.stake_account.to_account_info(),
                        ctx.accounts.owner.to_account_info(),
                        ctx.accounts.clock.to_account_info(),
                        ctx.accounts.stake_history.to_account_info(),
                        ctx.accounts.owner.to_account_info(),
                        ctx.accounts.resolution_account.to_account_info(),
                    ],
                    signer_seeds,
                )?;
            }
            false => {
                invoke(
                    &withdraw(
                        &ctx.accounts.stake_account.key(),
                        &ctx.accounts.owner.key(),
                        &ctx.accounts.owner.key(),
                        withdraw_amount,
                        None,
                    ),
                    &[
                        ctx.accounts.stake_account.to_account_info(),
                        ctx.accounts.owner.to_account_info(),
                        ctx.accounts.clock.to_account_info(),
                        ctx.accounts.stake_history.to_account_info(),
                        ctx.accounts.owner.to_account_info(),
                    ],
                )?;
            }
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeResolution<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        space = 8 + ResolutionAccount::INIT_SPACE,
        payer = owner,
        seeds = [b"resolution", owner.key().as_ref()],
        bump
    )]
    pub resolution_account: Account<'info, ResolutionAccount>,

    /// CHECK: We create the stake account in the instruction hence SystemProgram will fail if it's an existing account
    #[account(mut)]
    pub stake_account: Signer<'info>,

    /// CHECK: The delegate instruction should fail if not a valid Vote account
    #[account(
        constraint = validator_vote_account.owner == &vote::program::ID @ ResolutionErrorCode::InvalidVoteAccount
    )]
    pub validator_vote_account: AccountInfo<'info>,

    /// CHECK: We validate the stake config account
    #[account(
        constraint = stake_config.key() == pubkey!("StakeConfig11111111111111111111111111111111").key()
    )]
    pub stake_config: AccountInfo<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub clock: Sysvar<'info, Clock>,
    pub stake_history: Sysvar<'info, StakeHistory>,

    /// CHECK: We validate the program ID in the instruction
    #[account(
        executable,
        constraint = stake_program.key() == stake::program::ID @ ResolutionErrorCode::InvalidStakeProgram
    )]
    pub stake_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveResolution<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account()]
    pub owner: SystemAccount<'info>,

    #[account(
        mut,
        has_one = owner,
        seeds = [b"resolution", owner.key().as_ref()],
        bump
    )]
    pub resolution_account: Account<'info, ResolutionAccount>,
}

#[derive(Accounts)]
pub struct DeactivateResolutionStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: We validate using has_one and the owner of the account
    #[account(
        mut,
        constraint = stake_account.owner == &stake::program::ID @ ResolutionErrorCode::InvalidStakeAccount
    )]
    pub stake_account: AccountInfo<'info>,

    #[account(
        mut,
        has_one = owner,
        has_one = stake_account,
        seeds = [b"resolution", owner.key().as_ref()],
        bump
    )]
    pub resolution_account: Account<'info, ResolutionAccount>,

    pub clock: Sysvar<'info, Clock>,

    /// CHECK: We validate the program ID in the instruction
    #[account(
        executable,
        constraint = stake_program.key() == stake::program::ID @ ResolutionErrorCode::InvalidStakeProgram
    )]
    pub stake_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseResolution<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: We validate using has_one and the owner of the account
    #[account(
        mut,
        constraint = stake_account.owner == &stake::program::ID @ ResolutionErrorCode::InvalidStakeAccount
    )]
    pub stake_account: AccountInfo<'info>,

    #[account(
        mut,
        close = owner,
        has_one = owner,
        has_one = stake_account,
        seeds = [b"resolution", owner.key().as_ref()],
        bump
    )]
    pub resolution_account: Account<'info, ResolutionAccount>,

    pub clock: Sysvar<'info, Clock>,
    pub stake_history: Sysvar<'info, StakeHistory>,

    /// CHECK: We validate the program ID in the instruction
    #[account(
        executable,
        constraint = stake_program.key() == stake::program::ID @ ResolutionErrorCode::InvalidStakeProgram
    )]
    pub stake_program: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct ResolutionAccount {
    owner: Pubkey,
    #[max_len(512)]
    text: String,
    #[max_len(3)]
    approvers: Vec<Pubkey>,
    #[max_len(3)]
    approved_by: Vec<Pubkey>,
    stake_amount: u64,
    stake_account: Pubkey,
    start_time: i64,
    end_time: i64,
    bump: u8,
}
