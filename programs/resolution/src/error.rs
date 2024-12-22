use anchor_lang::prelude::*;

#[error_code]
pub enum ResolutionErrorCode {
    #[msg("Custom error message")]
    CustomError,
    #[msg("Invalid Stake Program")]
    InvalidStakeProgram,
    #[msg("Invalid Vote Account")]
    InvalidVoteAccount,
    #[msg("Invalid Stake Account")]
    InvalidStakeAccount,
    #[msg("Invalid number of approvers")]
    InvalidNumApprovers,
    #[msg("Not enough approvals")]
    NotEnoughApprovals,
    #[msg("Invalid approver")]
    InvalidApprover,
    #[msg("Invalid resolution signature")]
    InvalidResolutionSignature,
    #[msg("Lockup in force")]
    LockupInForce,
}
