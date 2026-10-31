import { chaosStores } from "../../testing/store-contract";
import { runBillingStoreContract } from "../../testing/billing-store-contract";
import { createInMemoryStores } from "./index";

runBillingStoreContract("in-memory", () => createInMemoryStores());
runBillingStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores()));
