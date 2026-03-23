import { ChatMessage } from "../ChatMessage";

export default function ChatMessageExample() {
  return (
    <div className="space-y-4 p-6 bg-background">
      <ChatMessage
        role="ai"
        content="Hello! I'll help you create a comprehensive CIM for your business. Let's start with some basic information. What industry does your business operate in?"
        timestamp="2:30 PM"
      />
      <ChatMessage
        role="user"
        content="We're in the restaurant industry, specifically fast-casual dining."
        timestamp="2:31 PM"
      />
      <ChatMessage
        role="ai"
        content="Great! Fast-casual dining is a dynamic sector. Can you tell me about your restaurant's unique value proposition? What sets it apart from competitors?"
        timestamp="2:31 PM"
      />
    </div>
  );
}
