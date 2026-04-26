import unittest
from src.slack_message_retriever import SlackMessageRetriever

class TestSlackMessageRetriever(unittest.TestCase):
    def setUp(self):
        # Setup code, such as initializing mock APIs or test data
        self.retriever = SlackMessageRetriever()

    def test_ingestion(self):
        # Example test for ingestion
        messages = self.retriever.retrieve_messages()
        self.assertIsInstance(messages, list, "The result should be a list")
        self.assertGreater(len(messages), 0, "There should be at least one message retrieved")

if __name__ == '__main__':
    unittest.main()