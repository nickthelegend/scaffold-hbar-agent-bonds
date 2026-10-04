import { Client, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import type { MessagePublisher, PublishedMessage } from "./messages";

/** Publishes receipts with the agent's own Hedera account, which is the receipt topic's submit key. */
export class HcsPublisher implements MessagePublisher {
  constructor(private readonly client: Client) {}

  async publish(topicId: string, message: string): Promise<PublishedMessage> {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(message)
      .execute(this.client);
    const receipt = await response.getReceipt(this.client);
    return {
      topicId,
      sequenceNumber: Number(receipt.topicSequenceNumber ?? 0),
      transactionId: response.transactionId.toString(),
    };
  }
}
