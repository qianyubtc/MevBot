// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPancakeRouter {
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title  SandwichProxy
/// @notice Per-user MEV sandwich executor for BSC PancakeSwap V2.
///         Deploy one per wallet. Frontrun + backrun without a separate approve tx.
///
///         Flow:
///           tx N   → frontrun(router, token, wbnb, minOut)  payable, nonce N
///           tx N+1 → backrun(router, token, wbnb, 0)              nonce N+1
///
///         Both submitted back-to-back off-chain; ideally land in the same block.
///         backrun() sells ALL tokens held by this contract, so the amount is
///         always correct regardless of buy-side slippage.
contract SandwichProxy {
    address public immutable owner;

    // Tracks which (token ++ router) pairs already have max-approval
    // so we never pay an extra approve tx after the first use per pair
    mapping(bytes32 => bool) private _approved;

    error NotOwner();
    error NoBNB();
    error NoTokens();
    error SendFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ── Step 1: front-run ────────────────────────────────────────────────────
    /// @param router       PancakeSwap V2 router address
    /// @param token        Target token address
    /// @param wbnb         WBNB address  (0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c)
    /// @param amountOutMin Minimum tokens to receive (slippage guard)
    function frontrun(
        address router,
        address token,
        address wbnb,
        uint256 amountOutMin
    ) external payable onlyOwner {
        if (msg.value == 0) revert NoBNB();

        // One-time max approval per (token, router) — pays ~5k gas first call, 0 gas after
        bytes32 key = keccak256(abi.encodePacked(token, router));
        if (!_approved[key]) {
            IERC20(token).approve(router, type(uint256).max);
            _approved[key] = true;
        }

        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = token;

        IPancakeRouter(router).swapExactETHForTokens{value: msg.value}(
            amountOutMin,
            path,
            address(this),          // tokens land in this contract
            block.timestamp + 60
        );
    }

    // ── Step 2: back-run ─────────────────────────────────────────────────────
    /// @notice Sells ALL tokens this contract holds. Amount is always exact —
    ///         no need to pass it from the off-chain caller.
    /// @param amountOutMin Minimum BNB to receive (0 = accept any, risky)
    function backrun(
        address router,
        address token,
        address wbnb,
        uint256 amountOutMin
    ) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert NoTokens();

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = wbnb;

        // BNB proceeds go directly to owner — one less transfer
        IPancakeRouter(router).swapExactTokensForETH(
            balance,
            amountOutMin,
            path,
            owner,
            block.timestamp + 60
        );
    }

    // ── Emergency rescue ─────────────────────────────────────────────────────
    function rescueBNB() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = owner.call{value: bal}("");
            if (!ok) revert SendFailed();
        }
    }

    function rescueToken(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(owner, bal);
    }

    receive() external payable {}
}
