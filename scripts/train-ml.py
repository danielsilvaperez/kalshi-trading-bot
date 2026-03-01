#!/usr/bin/env python3
"""
ML Training Pipeline for Kalshi Trading Bot
Automatically retrains model weekly on trade history
"""
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score
import json
import sys
from datetime import datetime, timedelta
import os

TRADE_LOG = './logs/ml-features.csv'
MODEL_OUTPUT = './models/entry_filter.json'
TRAINING_REPORT = './logs/training-report.json'

def load_and_label_data():
    """Load trade data and prepare for training"""
    if not os.path.exists(TRADE_LOG):
        print(f"No trade log found at {TRADE_LOG}")
        return None, None
    
    df = pd.read_csv(TRADE_LOG)
    
    # Only use completed trades (have exit data)
    completed = df[df['action'] == 'SELL'].copy()
    
    if len(completed) < 10:
        print(f"Only {len(completed)} completed trades - need at least 10 to train")
        return None, None
    
    # Calculate label if not present
    if 'label' not in completed.columns or completed['label'].isna().all():
        completed['label'] = completed['netPnl'].apply(
            lambda x: 1 if x > 0.05 else (-1 if x < -0.05 else 0)
        )
    
    # Match with entry data for features
    entries = df[df['action'] == 'BUY'][['timestamp', 'ticker', 'side']].copy()
    entries['entry_time'] = pd.to_datetime(entries['timestamp'])
    
    completed['exit_time'] = pd.to_datetime(completed['timestamp'])
    
    # Merge to get entry features
    merged = []
    for _, exit_row in completed.iterrows():
        # Find matching entry
        match = entries[
            (entries['ticker'] == exit_row['ticker']) & 
            (entries['side'] == exit_row['side']) &
            (entries['entry_time'] < exit_row['exit_time'])
        ].sort_values('entry_time', ascending=False).head(1)
        
        if not match.empty:
            entry = match.iloc[0]
            # Get entry features from original data
            entry_features = df[
                (df['timestamp'] == entry['timestamp']) &
                (df['action'] == 'BUY')
            ].iloc[0]
            
            merged.append({
                **entry_features.to_dict(),
                'exitPrice': exit_row['exitPrice'],
                'netPnl': exit_row['netPnl'],
                'grossPnl': exit_row['grossPnl'],
                'fee': exit_row['fee'],
                'exitReason': exit_row['exitReason'],
                'label': exit_row['label'],
                'holdingTimeMs': exit_row['holdingTimeMs']
            })
    
    if not merged:
        print("Could not match entries with exits")
        return None, None
    
    df = pd.DataFrame(merged)
    
    # Feature engineering
    features = [
        'entryPrice', 'btcPrice', 'btcVolatility5m', 'btcTrend30m',
        'spread', 'depthYes', 'depthNo', 'imbalance',
        'minsToExpiry', 'timeOfDay', 'dayOfWeek',
        'signalConfidence', 'volatilitySignal'
    ]
    
    X = df[features].fillna(0)
    y = df['label']
    
    print(f"Training on {len(df)} completed trades")
    print(f"Class distribution:\n{y.value_counts()}")
    
    return X, y

def train_model(X, y):
    """Train Random Forest classifier"""
    # Split: 80% train, 20% test
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    
    # Train with balanced classes
    clf = RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        min_samples_split=5,
        min_samples_leaf=2,
        class_weight='balanced',
        random_state=42
    )
    
    clf.fit(X_train, y_train)
    
    # Evaluate
    y_pred = clf.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    report = classification_report(y_test, y_pred, output_dict=True)
    
    print(f"\nTest Accuracy: {accuracy:.2%}")
    print(classification_report(y_test, y_pred))
    
    # Feature importance
    importance = pd.DataFrame({
        'feature': X.columns,
        'importance': clf.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance:")
    print(importance.head(10))
    
    return clf, accuracy, report, importance

def save_model(clf, accuracy, report, importance):
    """Save model in format readable by Node.js"""
    # Convert sklearn tree to JSON format
    def tree_to_dict(tree, feature_names):
        tree_ = tree.tree_
        def recurse(node):
            if tree_.children_left[node] == tree_.children_right[node]:
                # Leaf
                return {
                    'prediction': int(np.argmax(tree_.value[node])),
                    'confidence': float(np.max(tree_.value[node]) / np.sum(tree_.value[node]))
                }
            else:
                # Internal node
                return {
                    'feature': feature_names[tree_.feature[node]],
                    'threshold': float(tree_.threshold[node]),
                    'left': recurse(tree_.children_left[node]),
                    'right': recurse(tree_.children_right[node])
                }
        return recurse(0)
    
    # Use first tree as primary
    tree_json = tree_to_dict(clf.estimators_[0], clf.feature_names_in_)
    
    model_data = {
        'tree': tree_json,
        'accuracy': float(accuracy),
        'trained_at': datetime.now().isoformat(),
        'trades': len(clf.estimators_),
        'feature_importance': importance.to_dict('records'),
        'classification_report': report
    }
    
    os.makedirs(os.path.dirname(MODEL_OUTPUT), exist_ok=True)
    with open(MODEL_OUTPUT, 'w') as f:
        json.dump(model_data, f, indent=2)
    
    print(f"\nModel saved to {MODEL_OUTPUT}")
    
    # Save training report
    with open(TRAINING_REPORT, 'w') as f:
        json.dump(model_data, f, indent=2)
    
    return accuracy

def should_deploy(accuracy):
    """Determine if new model is good enough to deploy"""
    MIN_ACCURACY = 0.55  # Must beat random
    
    # Load previous model accuracy if exists
    prev_accuracy = 0
    if os.path.exists(MODEL_OUTPUT):
        try:
            with open(MODEL_OUTPUT) as f:
                prev = json.load(f)
                prev_accuracy = prev.get('accuracy', 0)
        except:
            pass
    
    print(f"\nPrevious accuracy: {prev_accuracy:.2%}")
    print(f"New accuracy: {accuracy:.2%}")
    
    if accuracy >= MIN_ACCURACY and accuracy >= prev_accuracy:
        print("✓ Model passes deployment threshold")
        return True
    else:
        print("✗ Model rejected - keeping previous")
        return False

def main():
    print("=" * 50)
    print("Kalshi ML Training Pipeline")
    print(f"Started: {datetime.now().isoformat()}")
    print("=" * 50)
    
    # Load data
    X, y = load_and_label_data()
    if X is None:
        print("Insufficient data for training")
        sys.exit(1)
    
    # Train
    clf, accuracy, report, importance = train_model(X, y)
    
    # Save
    save_model(clf, accuracy, report, importance)
    
    # Deploy decision
    if should_deploy(accuracy):
        print("\n🚀 DEPLOY: New model is ready for trading")
        sys.exit(0)
    else:
        print("\n⏸️  KEEP: Previous model remains active")
        sys.exit(1)

if __name__ == '__main__':
    main()
