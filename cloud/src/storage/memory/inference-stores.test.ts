import { runInferenceStoreContract } from "../../testing/inference-store-contract";
import { chaosStores } from "../../testing/store-contract";
import { createInMemoryStores } from "./index";

// The inference module's store behavior: the reviewer follow-ups and the atomic operations, plain and with
// every call wrapped in random yields that reorder concurrent callers.
runInferenceStoreContract("in-memory", () => createInMemoryStores());
runInferenceStoreContract("in-memory with chaos", () => chaosStores(createInMemoryStores(), 4242));
runInferenceStoreContract("in-memory with chaos (second seed)", () => chaosStores(createInMemoryStores(), 99));
