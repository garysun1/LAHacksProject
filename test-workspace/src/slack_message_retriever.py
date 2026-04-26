import os
import slack_sdk

class SlackMessageRetriever:
    def __init__(self, token):
        self.client = slack_sdk.WebClient(token=token)

    def fetch_messages(self, channel_id, limit=100):
        try:
            response = self.client.conversations_history(channel=channel_id, limit=limit)
            return response['messages'] if response['ok'] else []
        except Exception as e:
            print(f"Failed to fetch messages: {str(e)}")
            return []